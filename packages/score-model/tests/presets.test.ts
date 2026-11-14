// The part presets and what a new score starts with (docs/spec/commands.md, section 10): the
// table, the names new parts are numbered under, and the tuning options of a fretted part.
import { expect, test } from "vitest";

import { PART_PRESETS, partNames, pitchName, TUNING_OPTIONS, tuningFor } from "../src/index";

test("every preset is the row of its instrument in the table of docs/spec/commands.md, section 10", () => {
  // Copied from the table, row by row: the spec is the source here, not the code.
  expect(PART_PRESETS).toEqual({
    guitar6: { kind: "fretted", tuning: [64, 59, 55, 50, 45, 40], staves: [{ clef: "tab" }], program: 25 },
    guitar7: { kind: "fretted", tuning: [64, 59, 55, 50, 45, 40, 35], staves: [{ clef: "tab" }], program: 25 },
    bass4: { kind: "fretted", tuning: [43, 38, 33, 28], staves: [{ clef: "tab" }], program: 33 },
    bass5: { kind: "fretted", tuning: [43, 38, 33, 28, 23], staves: [{ clef: "tab" }], program: 33 },
    drums: { kind: "percussion", tuning: [], staves: [{ clef: "neutral" }], program: 0 },
    keys: { kind: "pitched", tuning: [], staves: [{ clef: "treble" }, { clef: "bass" }], program: 0 },
    vocals: { kind: "pitched", tuning: [], staves: [{ clef: "treble" }], program: 53 },
  });
});

test("new parts are numbered by the name of their preset; seven-string guitars count with guitars, five-string basses with basses", () => {
  expect(partNames(["guitar6", "guitar7", "drums", "keys", "bass4", "bass5", "vocals"])).toEqual(["吉他 1", "吉他 2", "鼓 1", "鍵盤 1", "貝斯 1", "貝斯 2", "人聲 1"]);
  // A part already in the score keeps its number: the new one comes after the highest.
  expect(partNames(["guitar6", "drums"], ["吉他 1", "吉他 3", "吉他手", "鼓"])).toEqual(["吉他 4", "鼓 1"]);
});

test("each tuning option of a fretted part, for four to seven strings, from the first string", () => {
  // Worked out by hand from the table and the rules: Drop lowers the lowest string a whole tone,
  // the other two lower every string a semitone or a whole tone.
  const expected = {
    4: { standard: [43, 38, 33, 28], drop: [43, 38, 33, 26], halfDown: [42, 37, 32, 27], wholeDown: [41, 36, 31, 26] },
    5: { standard: [43, 38, 33, 28, 23], drop: [43, 38, 33, 28, 21], halfDown: [42, 37, 32, 27, 22], wholeDown: [41, 36, 31, 26, 21] },
    6: { standard: [64, 59, 55, 50, 45, 40], drop: [64, 59, 55, 50, 45, 38], halfDown: [63, 58, 54, 49, 44, 39], wholeDown: [62, 57, 53, 48, 43, 38] },
    7: { standard: [64, 59, 55, 50, 45, 40, 35], drop: [64, 59, 55, 50, 45, 40, 33], halfDown: [63, 58, 54, 49, 44, 39, 34], wholeDown: [62, 57, 53, 48, 43, 38, 33] },
  };
  for (const strings of [4, 5, 6, 7] as const) {
    expect(Object.fromEntries(TUNING_OPTIONS.map((option) => [option, tuningFor(option, strings)]))).toEqual(expected[strings]);
  }
  // A new array each time: changing one tuning never changes the presets.
  const tuning = tuningFor("standard", 6);
  tuning[0] = 0;
  expect(PART_PRESETS.guitar6.tuning[0]).toBe(64);
  expect(() => tuningFor("standard", 3)).toThrow();
});

test("a string of a custom tuning is shown by the name of its pitch, middle C being C4", () => {
  expect([40, 45, 64, 61, 70, 35, 0, 127].map(pitchName)).toEqual(["E2", "A2", "E4", "C#4", "A#4", "B1", "C-1", "G9"]);
});
