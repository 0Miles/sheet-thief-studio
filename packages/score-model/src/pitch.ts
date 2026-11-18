// The pitch of a staff's positions and the spelling of its notes (docs/spec/commands.md, 5.1 and
// 5.8; docs/spec/schema.md, 8.1). A pitched note is keyed by its MIDI pitch ("n61"); where it is
// drawn depends on the clef of its staff and on how it is spelled ("C#" on C's position, "Db" on
// D's). Pure functions: the commands that enter and move notes read the document and call these.
import type { KeySignature, PitchedClef } from "./schema";

/** The note names, in the order of a scale from C. */
export const NOTE_LETTERS = ["C", "D", "E", "F", "G", "A", "B"] as const;
export type NoteLetter = (typeof NOTE_LETTERS)[number];

/** The pitch class of each letter without a sharp or a flat. */
const LETTER_CLASSES = [0, 2, 4, 5, 7, 9, 11] as const;

/** A spelling as a letter and how many semitones its accidental moves it (−2 to 2). */
interface Spelling {
  letter: number;
  alter: number;
}

/**
 * Where the top line of a five-line staff is, as a diatonic step (a step is a staff position: C4
 * is 4 × 7 = 28, D4 29): F5 on a treble staff, A3 on a bass staff, and F4 on the treble clef with
 * an 8 below, which sounds an octave lower than written.
 */
const TOP_LINE: Record<PitchedClef, number> = { treble: 5 * 7 + 3, bass: 3 * 7 + 5, "treble-8vb": 4 * 7 + 3 };

const modulo = (value: number, by: number) => ((value % by) + by) % by;

/** The MIDI pitch of the natural note of a diatonic step. */
function pitchOfStep(step: number): number {
  return (Math.floor(step / 7) + 1) * 12 + LETTER_CLASSES[modulo(step, 7)]!;
}

/**
 * The MIDI pitch of the natural note on a staff position of a clef (docs/spec/commands.md, 5.1):
 * 0 is the top line, 8 the bottom one, a position is half a staff space, so ↑ and ↓ go a step of
 * the scale.
 */
export function naturalAt(clef: PitchedClef, line: number): number {
  return pitchOfStep(TOP_LINE[clef] - line);
}

const ACCIDENTALS: Record<string, number> = { "": 0, "#": 1, b: -1, "##": 2, x: 2, bb: -2 };

/** A spelling as `spell` writes it ("C#", "Db", "F##" or "Fx", "Bbb"); none for one of another form. */
function spellingOf(spell: string): Spelling | undefined {
  const match = /^([A-G])(#|b|##|x|bb)?$/.exec(spell);
  if (match === null) return undefined;
  return { letter: NOTE_LETTERS.indexOf(match[1] as NoteLetter), alter: ACCIDENTALS[match[2] ?? ""]! };
}

/** How a spelling is written: the commands write a double sharp as "##" (docs/spec/schema.md, 8.1). */
function spellOf({ letter, alter }: Spelling): string {
  return NOTE_LETTERS[letter]! + ({ [-2]: "bb", [-1]: "b", 0: "", 1: "#", 2: "##" } as Record<number, string>)[alter]!;
}

/** Whether a spelling names a pitch: its letter and accidental give the pitch's class. */
function spells({ letter, alter }: Spelling, pitch: number): boolean {
  return modulo(LETTER_CLASSES[letter]! + alter, 12) === modulo(pitch, 12);
}

/** The order the sharps of a key come in (F, C, G…), and its flats the other way round (B, E, A…). */
const SHARPS = [3, 0, 4, 1, 5, 2, 6];

/** The semitones a key moves a letter by: +1 for one of its sharps, −1 for one of its flats. */
function keyAlterOf(letter: number, { fifths }: KeySignature): number {
  if (fifths > 0) return SHARPS.indexOf(letter) < fifths ? 1 : 0;
  if (fifths < 0) return SHARPS.indexOf(letter) >= 7 + fifths ? -1 : 0;
  return 0;
}

/** A white key's natural spelling, or a black key's sharp (`up`) or flat one. */
function plainSpelling(pitch: number, sharp: boolean): Spelling {
  const pitchClass = modulo(pitch, 12);
  const natural = LETTER_CLASSES.indexOf(pitchClass as (typeof LETTER_CLASSES)[number]);
  if (natural >= 0) return { letter: natural, alter: 0 };
  return sharp ? { letter: LETTER_CLASSES.indexOf((pitchClass - 1) as 0), alter: 1 } : { letter: LETTER_CLASSES.indexOf((pitchClass + 1) as 2), alter: -1 };
}

/**
 * How a note without a spelling of its own is spelled (docs/spec/schema.md, 8.1): a white key
 * natural; a black key sharp in a key of sharps and in C major (A minor), flat in a key of flats.
 */
export function defaultSpelling(pitch: number, keySig: KeySignature): string {
  return spellOf(plainSpelling(pitch, keySig.fifths >= 0));
}

/**
 * How `]` and `[` spell the note they move a semitone (docs/spec/commands.md, 5.8): on a black key
 * sharp going up (`1`), flat going down (`-1`); on a white key natural.
 */
export function semitoneSpelling(pitch: number, step: 1 | -1): string {
  return spellOf(plainSpelling(pitch, step === 1));
}

/**
 * The accidental a note must be drawn with for it to stand where `lineOfPitch` puts it, whatever
 * the renderer would choose in the key (alphaTab spells a white key E♯ or C♭ in a key of six or
 * seven sharps or flats): that of its own spelling when it names its pitch (0 for a natural), else
 * 0 on a white key, which the default spelling writes natural in every key; none for a black key
 * without a spelling of its own, whose sharp or flat the key decides alike in the renderer and in
 * `defaultSpelling` (docs/spec/schema.md, 8.1).
 */
export function drawnAccidentalOf(pitch: number, spell: string | undefined): number | undefined {
  const own = spell === undefined ? undefined : spellingOf(spell);
  if (own !== undefined && spells(own, pitch)) return own.alter;
  return plainSpelling(pitch, true).alter === 0 ? 0 : undefined;
}

/** The spelling a note is drawn with: its own when it names its pitch, else the key's default (docs/spec/schema.md, 8.1). */
function drawnSpelling(pitch: number, spell: string | undefined, keySig: KeySignature): Spelling {
  const own = spell === undefined ? undefined : spellingOf(spell);
  return own !== undefined && spells(own, pitch) ? own : plainSpelling(pitch, keySig.fifths >= 0);
}

/**
 * The staff position a note is drawn on in a clef: that of its spelled letter (C♯4 and C4 on one
 * position, D♭4 on D4's; B♯3, which sounds as C4, on B3's). A spelling that does not name its
 * pitch is drawn as the key's default, as the projection draws it.
 */
export function lineOfPitch(clef: PitchedClef, pitch: number, spell: string | undefined, keySig: KeySignature): number {
  const { letter, alter } = drawnSpelling(pitch, spell, keySig);
  const octave = Math.floor((pitch - alter - LETTER_CLASSES[letter]!) / 12) - 1;
  return TOP_LINE[clef] - (octave * 7 + letter);
}

/** A note a letter key enters: its pitch, how it is spelled, and the staff position it is drawn on. */
export interface EnteredPitch {
  pitch: number;
  spell: string;
  line: number;
}

/**
 * The note a letter key enters at a staff position (docs/spec/commands.md, 5.1): of all the notes
 * of that letter, the one fewest steps of the scale from the natural note of the position (seven
 * letters are never as far one way as the other, so there is no tie), with the sharp or flat the
 * key gives the letter. None for a pitch out of 0 to 127.
 */
export function enteredPitch(clef: PitchedClef, line: number, letter: NoteLetter, keySig: KeySignature): EnteredPitch | undefined {
  const from = TOP_LINE[clef] - line;
  const index = NOTE_LETTERS.indexOf(letter);
  const up = modulo(index - from, 7);
  const step = up <= 3 ? from + up : from + up - 7;
  const alter = keyAlterOf(index, keySig);
  const pitch = pitchOfStep(step) + alter;
  if (pitch < 0 || pitch > 127) return undefined;
  return { pitch, spell: spellOf({ letter: index, alter }), line: TOP_LINE[clef] - step };
}
