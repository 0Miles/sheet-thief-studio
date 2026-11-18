// The scores the measurements open in the edit view: made here, in the test, and written into the
// end-to-end database as a score of the admin's, EDITOR an Editor of it (`seedScore`): the other
// member who edits it meanwhile in S2. No page or API of the app makes them: a 100 × 5 score has
// no place in any build (docs/spec/testing.md, section 2).
import {
  addPart,
  type BeatChange,
  type BeatWrite,
  changeBeatAt,
  createScore,
  type Cursor,
  cursorAt,
  DRUM_PIECES,
  DYNAMICS,
  flagsOf,
  insertBars,
  insertBeat,
  LOCAL,
  MAIN_VOICE,
  type NewPart,
  type NoteJSON,
  type NoteValue,
  readScore,
  setNote,
  voiceKey,
} from "@studio/score-model";
import * as Y from "yjs";

import { ADMIN, EDITOR } from "../environment";
import { seedScore } from "../pages";

const BASS_TUNING = [43, 38, 33, 28];
const DEMO_TITLE = "Demo";
const perfTitle = (bars: number, techniques: boolean) => `Perf ${bars} × ${BAND.length}${techniques ? " techniques" : ""}`;

/** The parts of the demo band, in the order they are added. */
const BAND: NewPart[] = [
  { name: "Guitar 1", kind: "fretted", program: 29 },
  { name: "Drums", kind: "percussion", program: 0 },
  { name: "Keys", kind: "pitched", program: 0 },
  { name: "Bass", kind: "fretted", tuning: BASS_TUNING, program: 33 },
  { name: "Guitar 2", kind: "fretted", program: 30 },
];

type Notes = Record<string, NoteJSON>;
type Markings = NonNullable<BeatWrite["set"]>;
/** A beat to append: its note value, its notes and, if any, its markings. */
type NewBeat = [NoteValue, Notes] | [NoteValue, Notes, Markings | undefined];

/** Put these markings on a beat (stroke, slap, pop, dynamic, text). */
const marked = (set: Markings): BeatChange<void> => ({ decide: () => undefined, turn: () => ({ set }) });

/** The second voice of the first staff: the feet of the drums (#45). */
const SECOND_VOICE = voiceKey(0, 1);

/** Append beats to a bar of a part, each with its notes and markings: to the first voice unless told otherwise. */
function write(doc: Y.Doc, partId: string, barId: string, beats: NewBeat[], voice?: string): void {
  let cursor: Cursor = voice === undefined ? cursorAt(doc, partId, barId) : { ...cursorAt(doc, partId, barId), voice, beatId: null, at: "after" };
  for (const [value, notes, markings] of beats) {
    cursor = insertBeat(doc, { ...cursor, at: "after" }, { value });
    for (const [key, note] of Object.entries(notes)) setNote(doc, cursor, key, note);
    if (markings !== undefined) cursor = changeBeatAt(doc, cursor, marked(markings));
  }
}

const { kick, snare, hiHatClosed, hiHatOpen, hiHatPedal, crash, ride, tomHigh, tomFloor } = DRUM_PIECES;
const p = (...ids: number[]): Notes => Object.fromEntries(ids.map((id) => [`p${id}`, {}]));

export interface DemoOptions {
  bars: number;
  /** How many parts of the band, from the first. */
  parts: number;
}

/**
 * A short band score. Bar 1 and 2 hold music in every part, bar 3 is half filled (it is
 * completed with rests on the page) and the rest is empty.
 */
function seedDemo(doc: Y.Doc, { bars, parts }: DemoOptions): void {
  doc.transact(() => {
    createScore(doc, DEMO_TITLE);
    const barIds = insertBars(doc, { after: null, count: bars });
    const [first, second, third] = barIds;
    BAND.slice(0, parts).forEach((part, index) => {
      const partId = addPart(doc, part);
      if (first === undefined || second === undefined || third === undefined) return;
      if (index === 0) {
        write(doc, partId, first, [
          [8, { s6: { fret: 0 } }],
          [8, { s5: { fret: 2 } }],
          [8, { s4: { fret: 2 } }],
          [8, { s3: { fret: 1 } }],
          [4, { s2: { fret: 0 }, s1: { fret: 0 } }],
          [4, {}],
        ]);
        write(doc, partId, second, [
          [4, { s5: { fret: 3 } }],
          [4, { s4: { fret: 12 }, s3: { fret: 12 } }],
          [2, { s1: { fret: 15 } }],
        ]);
        write(doc, partId, third, [[4, { s6: { fret: 3 } }]]);
      } else if (index === 1) {
        write(doc, partId, first, [
          [8, p(kick.id, hiHatClosed.id)],
          [8, p(hiHatClosed.id)],
          [8, p(snare.id, hiHatClosed.id)],
          [8, p(hiHatOpen.id)],
          [8, p(kick.id, ride.id)],
          [8, p(ride.id)],
          [8, p(snare.id, crash.id)],
          [8, p(tomHigh.id)],
        ]);
        write(doc, partId, second, [
          [4, p(kick.id, crash.id)],
          [4, p(snare.id)],
          [4, p(tomHigh.id)],
          [4, p(tomFloor.id)],
        ]);
        write(doc, partId, third, [[4, p(kick.id)]]);
      } else if (index === 2) {
        // The same pitch, 61, written once as C sharp and once as D flat; then 66 both ways.
        write(doc, partId, first, [
          [4, { n60: {} }],
          [4, { n61: { spell: "C#" } }],
          [4, { n61: { spell: "Db" } }],
          [4, { n64: {} }],
        ]);
        write(doc, partId, second, [
          [4, { n66: { spell: "F#" } }],
          [4, { n66: { spell: "Gb" } }],
          [2, { n67: {}, n72: {} }],
        ]);
        write(doc, partId, third, [[4, { n69: {} }]]);
      } else if (index === 3) {
        write(doc, partId, first, [
          [4, { s4: { fret: 0 } }],
          [4, { s4: { fret: 3 } }],
          [4, { s3: { fret: 2 } }],
          [4, { s3: { fret: 0 } }],
        ]);
      } else {
        write(doc, partId, first, [[1, { s6: { fret: 0 }, s5: { fret: 2 }, s4: { fret: 2 } }]]);
      }
    });
  }, LOCAL);
}

/** A repeatable stream of numbers, so that every run measures the same score. */
function sequence(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * below);
  };
}

/**
 * The techniques of the lead guitar's eighths, by their place in the bar, in the score with
 * techniques: every string technique of M1b (#26 to #30). The hammer-on and the slides go on to
 * the next note, which is on another string about three times in four: a dangling link.
 */
const LEAD_TECHNIQUES: Omit<NoteJSON, "fret">[] = [
  { legato: true },
  { slideOut: "shift" },
  { bend: { type: "bendRelease", semitones: 2 }, vibrato: true },
  { tap: true, accent: true },
  { harmonic: "natural", letRing: true },
  { ghost: true, staccato: true },
  { slideIn: "inBelow", palmMute: true },
  { dead: true },
];

/**
 * The score the latency is measured on: every bar of every part of the band holds eight eighths.
 * With `techniques` the same notes are marked as well: techniques, dynamics, strokes, slap and
 * pop, chord names, and ties, some of which dangle, so that `flagsOf` finds flags.
 */
function seedPerf(doc: Y.Doc, bars: number, techniques: boolean): void {
  const next = sequence(20261112);
  const scale = [60, 62, 63, 65, 67, 68, 70, 72];
  const flats: Record<number, string> = { 63: "Eb", 68: "Ab", 70: "Bb" };
  /** The note as it is, with `extra` when the score has techniques. */
  const and = (note: NoteJSON, extra: NoteJSON = {}): NoteJSON => (techniques ? { ...note, ...extra } : note);
  /** The markings of a beat when the score has techniques. */
  const marks = (markings: Markings | undefined): Markings | undefined => (techniques ? markings : undefined);
  doc.transact(() => {
    createScore(doc, perfTitle(bars, techniques));
    const barIds = insertBars(doc, { after: null, count: bars });
    const [lead, drums, keys, bass, rhythm] = BAND.map((part) => addPart(doc, part)) as [string, string, string, string, string];
    barIds.forEach((barId, bar) => {
      const root = next(8);
      const eighths = Array.from({ length: 8 }, (_, index) => index);
      // The first beat of a bar: a dynamic, and a chord name every fourth bar.
      const opening = (index: number): Markings | undefined => (index === 0 ? { dynamic: DYNAMICS[bar % DYNAMICS.length]!, ...(bar % 4 === 0 ? { text: "Em7" } : {}) } : undefined);
      write(doc, lead, barId, eighths.map((index): NewBeat => [8, { [`s${1 + next(4)}`]: and({ fret: 5 + next(12) }, LEAD_TECHNIQUES[index]) }, marks(opening(index))]));
      write(doc, rhythm, barId, eighths.map((index): NewBeat => {
        const muted = { palmMute: true } as const;
        return [8, { s6: and({ fret: root }, muted), s5: and({ fret: root + 2 }, muted), s4: and({ fret: root + 2 }, muted) }, marks({ stroke: index % 2 === 0 ? "down" : "up" })];
      }));
      write(doc, bass, barId, eighths.map((index): NewBeat => {
        const note = and({ fret: root + (index % 4 === 3 ? 2 : 0) }, index % 4 === 1 ? { ghost: true } : index === 7 ? { slideOut: "legato" } : {});
        return [8, { [`s${index % 4 === 3 ? 3 : 4}`]: note }, marks(index % 4 === 0 ? { slap: true } : index % 4 === 2 ? { pop: true } : undefined)];
      }));
      // Drums in two voices (#46): hands in the first, eighths of hi-hat with the snare on 2 and 4;
      // feet in the second, the kick on 1, 3 and the "and" of 3, the hi-hat pedal on 2 and 4.
      write(doc, drums, barId, eighths.map((index): NewBeat => {
        const notes = p(hiHatClosed.id, ...(index % 4 === 2 ? [snare.id] : []));
        if (index === 0) notes[`p${hiHatClosed.id}`] = and({}, { accent: true });
        if (index === 6) notes[`p${snare.id}`] = and({}, { ghost: true });
        return [8, notes];
      }));
      write(doc, drums, barId, [
        [4, p(kick.id)],
        [4, p(hiHatPedal.id)],
        [8, p(kick.id)],
        [8, p(kick.id)],
        [4, p(hiHatPedal.id)],
      ], SECOND_VOICE);
      write(doc, keys, barId, eighths.map((index): NewBeat => {
        const pitch = scale[next(scale.length)] as number;
        const spell = flats[pitch];
        // A tie on the fifth eighth: it dangles unless the eighth before has the same pitch.
        const note = and(spell ? { spell } : {}, index === 4 ? { tie: true } : index % 2 === 1 ? { staccato: true } : index === 0 ? { accent: true } : {});
        return [8, { [`n${pitch}`]: note }, marks(opening(index))];
      }));
    });
  }, LOCAL);
}

/** A score written into the end-to-end database: its id, the ids of its parts in order, and how many flags it has. */
export interface SeededScore {
  id: string;
  partIds: string[];
  flags: number;
}

/** Write a score made here into the end-to-end database, owned by the admin, with EDITOR an Editor of it. */
function seeded(title: string, seed: (doc: Y.Doc) => void): SeededScore {
  const doc = new Y.Doc();
  seed(doc);
  const state = Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
  const id = seedScore({ title, owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], state });
  const { score, invalid } = readScore(doc);
  return { id, partIds: score.parts.map((part) => part.id), flags: flagsOf(score, invalid).length };
}

/** A new demo score of the band. */
export function demoScore(options: DemoOptions): SeededScore {
  return seeded(DEMO_TITLE, (doc) => seedDemo(doc, options));
}

/** A new score the latency is measured on (100 bars × 5 parts unless told otherwise), plain or with techniques. */
export function perfScore(bars = 100, { techniques = false }: { techniques?: boolean } = {}): SeededScore {
  return seeded(perfTitle(bars, techniques), (doc) => seedPerf(doc, bars, techniques));
}

const DRUM_VOICES_TITLE = "Drums, two voices";

/**
 * Drums written hands and feet apart (#45): hands in the first voice, feet in the second. Bar 1
 * has both, bar 2 hands only (its second voice empty), bar 3 feet against quarters, bar 4 nothing.
 */
function seedDrumVoices(doc: Y.Doc): void {
  doc.transact(() => {
    createScore(doc, DRUM_VOICES_TITLE);
    const [first, second, third] = insertBars(doc, { after: null, count: 4 }) as [string, string, string, string];
    const partId = addPart(doc, { name: "Drums", kind: "percussion", program: 0 });
    /** Append beats to a voice of a bar. */
    const voice = (barId: string, key: string, beats: NewBeat[]) => write(doc, partId, barId, beats, key);
    const hands = Array.from({ length: 8 }, (_, index): NewBeat => [8, p(hiHatClosed.id, ...(index % 4 === 2 ? [snare.id] : []))]);
    voice(first, MAIN_VOICE, hands);
    voice(first, SECOND_VOICE, [
      [4, p(kick.id)],
      [8, p(hiHatPedal.id)],
      [8, p(kick.id)],
      [4, p(kick.id, hiHatPedal.id)],
      [4, p(hiHatPedal.id)],
    ]);
    voice(second, MAIN_VOICE, hands);
    voice(third, MAIN_VOICE, [
      [4, p(crash.id)],
      [4, p(snare.id)],
      [4, p(ride.id)],
      [4, p(snare.id)],
    ]);
    voice(third, SECOND_VOICE, [
      [8, p(kick.id)],
      [8, p(kick.id)],
      [2, p(hiHatPedal.id)],
      [16, p(kick.id)],
      [16, p(kick.id)],
      [8, p(kick.id)],
    ]);
  }, LOCAL);
}

/** A new score of drums written in two voices. */
export function drumVoicesScore(): SeededScore {
  return seeded(DRUM_VOICES_TITLE, seedDrumVoices);
}

/** A voice of the M3 cursor geometry score: its part (by index), voice key, note value, and each note's pitch and staff position. */
export interface StavesVoice {
  part: number;
  voice: string;
  value: NoteValue;
  notes: [pitch: number, position: number][];
}

/**
 * The voices of the M3 cursor geometry score (#47): a piano, a treble and a bass staff with two
 * voices on each, and a guitar written on a treble clef an octave down. One bar of four quarters,
 * then an empty bar. Each note has the staff position it is drawn on, worked out by hand from its
 * clef (0 the top line, 8 the bottom one): the treble staff's top line is F5, the bass staff's A3,
 * that of the treble clef an octave down F4. The same notes as `packages/score-render/tests/geometry.test.ts`.
 */
export const STAVES_VOICES: StavesVoice[] = [
  // F5, C5, G5, D5.
  { part: 0, voice: "0:0", value: 4, notes: [[77, 0], [72, 3], [79, -1], [74, 2]] },
  // E4, D4, F4, C4: under the first voice, never a second from it.
  { part: 0, voice: "0:1", value: 4, notes: [[64, 8], [62, 9], [65, 7], [60, 10]] },
  // A3, F2, C4, E2.
  { part: 0, voice: "1:0", value: 4, notes: [[57, 0], [41, 9], [60, -2], [40, 10]] },
  // C2, C3: halves.
  { part: 0, voice: "1:1", value: 2, notes: [[36, 12], [48, 5]] },
  // E4, E3, B3, G3: drawn an octave over, E5, E4, B4, G4.
  { part: 1, voice: "0:0", value: 4, notes: [[64, 1], [52, 8], [59, 4], [55, 6]] },
];

/** A new score of `STAVES_VOICES`. */
export function stavesScore(): SeededScore {
  return seeded("Staves", (doc) =>
    doc.transact(() => {
      createScore(doc, "Staves");
      const [barId] = insertBars(doc, { after: null, count: 2 });
      const partIds = [
        addPart(doc, { name: "Piano", kind: "pitched", staves: [{ clef: "treble" }, { clef: "bass" }] }),
        addPart(doc, { name: "Guitar", kind: "pitched", program: 25, staves: [{ clef: "treble-8vb" }] }),
      ];
      for (const { part, voice, value, notes } of STAVES_VOICES) {
        let cursor: Cursor = { ...cursorAt(doc, partIds[part]!, barId!), voice };
        for (const [pitch] of notes) cursor = setNote(doc, insertBeat(doc, { ...cursor, at: "after" }, { value }), `n${pitch}`, {});
      }
    }, LOCAL),
  );
}
