// The pitch of a staff's positions and the spelling of its notes (docs/spec/commands.md, 5.1 and
// 5.8; docs/spec/schema.md, 8.1): pure functions, no document.
import fc from "fast-check";
import { describe, expect, test } from "vitest";

import { defaultSpelling, drawnAccidentalOf, enteredPitch, type KeySignature, lineOfPitch, naturalAt, NOTE_LETTERS, PITCHED_CLEFS, type PitchedClef, semitoneSpelling } from "../src/index";

const C_MAJOR: KeySignature = { fifths: 0, mode: "major" };
const PITCH_CLASSES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 } as const;

/** MIDI pitch of a note named as "C4" (C4 is 60). */
function midiOf(name: string): number {
  const [, letter, octave] = /^([A-G])(-?\d)$/.exec(name)!;
  return (Number(octave) + 1) * 12 + PITCH_CLASSES[letter as keyof typeof PITCH_CLASSES];
}

/** The letter of the natural note on a position, from its pitch. */
function letterAt(clef: PitchedClef, line: number): string | undefined {
  const pitchClass = ((naturalAt(clef, line) % 12) + 12) % 12;
  return Object.entries(PITCH_CLASSES).find(([, value]) => value === pitchClass)?.[0];
}

// The staff positions −4 to 12, top first: 0 is the top line, 8 the bottom one.
const NATURALS: Record<PitchedClef, string> = {
  treble: "C6 B5 A5 G5 F5 E5 D5 C5 B4 A4 G4 F4 E4 D4 C4 B3 A3",
  bass: "E4 D4 C4 B3 A3 G3 F3 E3 D3 C3 B2 A2 G2 F2 E2 D2 C2",
  // Written as the treble clef, sounding an octave lower.
  "treble-8vb": "C5 B4 A4 G4 F4 E4 D4 C4 B3 A3 G3 F3 E3 D3 C3 B2 A2",
};

describe.each(PITCHED_CLEFS)("on a %s staff", (clef) => {
  test("each position from −4 to 12 is the natural note of the clef", () => {
    const names = NATURALS[clef].split(" ");
    expect(names.map((_, index) => naturalAt(clef, index - 4))).toEqual(names.map(midiOf));
  });

  test("a letter is entered in the octave nearest the cursor's position, on the position it is drawn on", () => {
    fc.assert(
      fc.property(fc.integer({ min: -4, max: 12 }), fc.constantFrom(...NOTE_LETTERS), (line, letter) => {
        const entered = enteredPitch(clef, line, letter, C_MAJOR)!;
        // Every position the letter is on, far above and below the staff: the entered one is the nearest.
        const positions = Array.from({ length: 41 }, (_, index) => index - 20).filter((at) => letterAt(clef, at) === letter);
        const nearest = Math.min(...positions.map((at) => Math.abs(at - line)));
        expect(Math.abs(entered.line - line)).toBe(nearest);
        expect(nearest).toBeLessThanOrEqual(3);
        expect(entered.pitch).toBe(naturalAt(clef, entered.line));
        expect(entered.spell).toBe(letter);
        expect(lineOfPitch(clef, entered.pitch, entered.spell, C_MAJOR)).toBe(entered.line);
      }),
    );
  });
});

test("on the middle line of a treble staff (B4), C is the C above, G the G below, B the B there", () => {
  expect(enteredPitch("treble", 4, "C", C_MAJOR)).toEqual({ pitch: midiOf("C5"), spell: "C", line: 3 });
  expect(enteredPitch("treble", 4, "G", C_MAJOR)).toEqual({ pitch: midiOf("G4"), spell: "G", line: 6 });
  expect(enteredPitch("treble", 4, "B", C_MAJOR)).toEqual({ pitch: midiOf("B4"), spell: "B", line: 4 });
  // On the bass staff's middle line (D3), A is the A below and F the F above.
  expect(enteredPitch("bass", 4, "A", C_MAJOR)).toEqual({ pitch: midiOf("A2"), spell: "A", line: 7 });
  expect(enteredPitch("bass", 4, "F", C_MAJOR)).toEqual({ pitch: midiOf("F3"), spell: "F", line: 2 });
});

test("the key's sharps and flats are put on the letter: F in D major is F♯, B in B♭ major is B♭", () => {
  expect(enteredPitch("treble", 4, "F", { fifths: 2, mode: "major" })).toEqual({ pitch: midiOf("F4") + 1, spell: "F#", line: 7 });
  expect(enteredPitch("treble", 4, "B", { fifths: -2, mode: "major" })).toEqual({ pitch: midiOf("B4") - 1, spell: "Bb", line: 4 });
  // D major sharpens F and C only.
  expect(enteredPitch("treble", 4, "G", { fifths: 2, mode: "major" })?.spell).toBe("G");
  expect(enteredPitch("treble", 4, "C", { fifths: 2, mode: "major" })?.spell).toBe("C#");
  // A minor key has the sharps of its relative major: B minor is two sharps.
  expect(enteredPitch("treble", 4, "C", { fifths: 2, mode: "minor" })?.spell).toBe("C#");
  // In C♯ major even B is sharp, and sounds as C; in C♭ major F is flat, and sounds as E.
  expect(enteredPitch("treble", 4, "B", { fifths: 7, mode: "major" })).toEqual({ pitch: midiOf("C5"), spell: "B#", line: 4 });
  expect(enteredPitch("treble", 4, "F", { fifths: -7, mode: "major" })).toEqual({ pitch: midiOf("E4"), spell: "Fb", line: 7 });
  expect(enteredPitch("bass", 12, "C", { fifths: -7, mode: "major" })).toEqual({ pitch: midiOf("C2") - 1, spell: "Cb", line: 12 });
});

test("the lowest note a letter enters is G♭1, three steps below C2 on the bass staff's lowest position; the highest F♯6, three above C6", () => {
  expect(enteredPitch("bass", 12, "G", { fifths: -7, mode: "major" })).toEqual({ pitch: 30, spell: "Gb", line: 15 });
  // F is nearer above: F2.
  expect(enteredPitch("bass", 12, "F", C_MAJOR)?.pitch).toBe(midiOf("F2"));
  expect(enteredPitch("treble", -4, "F", { fifths: 7, mode: "major" })).toEqual({ pitch: 90, spell: "F#", line: -7 });
});

test("the accidental a note is drawn with: its own spelling's when that names its pitch, a white key's natural else, a black key's left to the key", () => {
  expect(drawnAccidentalOf(65, "F")).toBe(0);
  expect(drawnAccidentalOf(65, undefined)).toBe(0);
  expect(drawnAccidentalOf(65, "E#")).toBe(1);
  expect(drawnAccidentalOf(62, "C##")).toBe(2);
  expect(drawnAccidentalOf(62, "Ebb")).toBe(-2);
  expect(drawnAccidentalOf(61, "Db")).toBe(-1);
  // A spelling of another pitch is not the note's: as if it had none.
  expect(drawnAccidentalOf(61, "C")).toBeUndefined();
  expect(drawnAccidentalOf(61, undefined)).toBeUndefined();
  expect(drawnAccidentalOf(64, "D#")).toBe(0);
});

test("a black key is spelled sharp in a key of sharps and in C major, flat in a key of flats; a white key is natural", () => {
  expect(defaultSpelling(61, { fifths: 3, mode: "major" })).toBe("C#");
  expect(defaultSpelling(61, C_MAJOR)).toBe("C#");
  expect(defaultSpelling(61, { fifths: 0, mode: "minor" })).toBe("C#");
  expect(defaultSpelling(61, { fifths: -1, mode: "major" })).toBe("Db");
  expect(defaultSpelling(70, { fifths: -1, mode: "major" })).toBe("Bb");
  expect(defaultSpelling(64, { fifths: -6, mode: "major" })).toBe("E");
});

test("a semitone up is spelled sharp on a black key, down flat, and natural on a white key", () => {
  expect(semitoneSpelling(61, 1)).toBe("C#");
  expect(semitoneSpelling(61, -1)).toBe("Db");
  expect(semitoneSpelling(65, 1)).toBe("F");
  expect(semitoneSpelling(64, -1)).toBe("E");
});

test("a note is drawn on the position of its spelled letter, B♯ and C♭ in the octave of their letter; a spelling of another pitch is not", () => {
  const c4 = lineOfPitch("treble", 60, "C", C_MAJOR);
  const d4 = lineOfPitch("treble", 62, "D", C_MAJOR);
  expect([c4, d4]).toEqual([10, 9]);
  expect(lineOfPitch("treble", 61, "C#", C_MAJOR)).toBe(c4);
  expect(lineOfPitch("treble", 61, "Db", C_MAJOR)).toBe(d4);
  // B♯3 sounds as C4 and is drawn on B3's position; C♭5 sounds as B4 and is drawn on C5's.
  expect(lineOfPitch("treble", 60, "B#", C_MAJOR)).toBe(11);
  expect(lineOfPitch("treble", 71, "Cb", C_MAJOR)).toBe(3);
  expect(lineOfPitch("treble", 62, "C##", C_MAJOR)).toBe(c4);
  expect(lineOfPitch("treble", 62, "Cx", C_MAJOR)).toBe(c4);
  expect(lineOfPitch("treble", 60, "Dbb", C_MAJOR)).toBe(d4);
  // No spelling, or one that is not this pitch's: the default spelling of the key.
  expect(lineOfPitch("treble", 61, undefined, { fifths: -2, mode: "major" })).toBe(d4);
  expect(lineOfPitch("treble", 61, undefined, C_MAJOR)).toBe(c4);
  expect(lineOfPitch("treble", 61, "E", C_MAJOR)).toBe(c4);
  // The clef moves the position, not the pitch.
  expect(lineOfPitch("bass", 60, "C", C_MAJOR)).toBe(-2);
  expect(lineOfPitch("treble-8vb", 60, "C", C_MAJOR)).toBe(3);
});
