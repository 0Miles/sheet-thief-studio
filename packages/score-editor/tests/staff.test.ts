// Typing on a staff (docs/spec/keymap.md, 4.3; docs/spec/commands.md, 5.1, 5.2 and 5.8): A to G
// enter a note in the octave nearest the cursor, spelled by the key, and add to a chord on a beat
// with notes; ] and [ move the notes of the cursor's line a semitone, Shift+↑ and Shift+↓ an
// octave; each one undo step.
import { expect, test } from "vitest";

import { PLATFORMS } from "./band";
import { sessionOn, undoEach } from "./support";

const shift = { shiftKey: true };
const notesOf = (beats: { notes: object }[]) => beats.map((beat) => beat.notes);

test.each(PLATFORMS)("on %s, C, E and G from the middle line make one beat of a chord, C5 E5 G5, each note one undo step", (platform) => {
  const { press, beats, cursor } = sessionOn("pitched", 2, platform);
  for (const key of ["c", "e", "g"]) expect(press(key), key).toBe(true);
  expect(notesOf(beats())).toEqual([{ n72: { spell: "C" }, n76: { spell: "E" }, n79: { spell: "G" } }]);
  // On the new beat, on the G's position (the space above the top line).
  expect(cursor()).toMatchObject({ beatId: beats()[0]!.id, at: "on", line: -1 });
  undoEach(press, platform, () => notesOf(beats()), [[{ n72: { spell: "C" }, n76: { spell: "E" } }], [{ n72: { spell: "C" } }], []]);
});

test("a letter typed in the append slot makes the beat → goes on from, as a digit does", () => {
  const { press, beats, cursor } = sessionOn("pitched");
  press("a");
  press("ArrowRight");
  expect(cursor()).toMatchObject({ beatId: beats()[0]!.id, at: "after" });
  press("b");
  expect(notesOf(beats())).toEqual([{ n69: { spell: "A" } }, { n71: { spell: "B" } }]);
});

test("in D major F is F♯ and C is C♯; in B♭ major B is B♭: the key of the cursor's bar spells the note", () => {
  const { session, press, beats } = sessionOn("pitched");
  session.setKeySig({ fifths: 2, mode: "major" });
  // From B4, F is F♯4; from there, C is C♯4.
  press("f");
  press("c");
  expect(notesOf(beats())).toEqual([{ n61: { spell: "C#" }, n66: { spell: "F#" } }]);
  session.setKeySig({ fifths: -2, mode: "major" });
  press("ArrowRight");
  // From C4, B is B♭3.
  press("b");
  expect(notesOf(beats())[1]).toEqual({ n58: { spell: "Bb" } });
});

test.each(PLATFORMS)("on %s, ] and [ move the notes of the line a semitone, spelled sharp up and flat down, each one undo step", (platform) => {
  const { press, beats, cursor } = sessionOn("pitched", 2, platform);
  // From B4, D is D5 (line 2) and F is F5 (line 0): back on D's line.
  press("d");
  press("f");
  press("ArrowDown");
  press("ArrowDown");
  expect(press("BracketRight")).toBe(true);
  expect(notesOf(beats())).toEqual([{ n75: { spell: "D#" }, n77: { spell: "F" } }]);
  // From D♯ a semitone up is E, on the position below the top line: the cursor goes there.
  press("BracketRight");
  expect(notesOf(beats())).toEqual([{ n76: { spell: "E" }, n77: { spell: "F" } }]);
  expect(cursor().line).toBe(1);
  expect(press("BracketLeft")).toBe(true);
  expect(notesOf(beats())).toEqual([{ n75: { spell: "Eb" }, n77: { spell: "F" } }]);
  undoEach(press, platform, () => notesOf(beats()), [
    [{ n76: { spell: "E" }, n77: { spell: "F" } }],
    [{ n75: { spell: "D#" }, n77: { spell: "F" } }],
    [{ n74: { spell: "D" }, n77: { spell: "F" } }],
  ]);
});

test.each(PLATFORMS)("on %s, Shift+↑ and Shift+↓ move the notes of the line an octave, keeping their spelling, the cursor with them; one undo step each", (platform) => {
  const { session, press, beats, cursor } = sessionOn("pitched", 2, platform);
  session.setKeySig({ fifths: -3, mode: "major" });
  // E♭ major: from B4, E is E♭5 on line 1.
  press("e");
  expect(notesOf(beats())).toEqual([{ n75: { spell: "Eb" } }]);
  expect(press("ArrowDown", 1000, shift)).toBe(true);
  expect(notesOf(beats())).toEqual([{ n63: { spell: "Eb" } }]);
  expect(cursor().line).toBe(8);
  press("ArrowDown", 1000, shift);
  expect(notesOf(beats())).toEqual([{ n51: { spell: "Eb" } }]);
  // E♭3 is drawn below the cursor's range: the cursor stops at its lowest position.
  expect(cursor().line).toBe(12);
  undoEach(press, platform, () => notesOf(beats()), [[{ n63: { spell: "Eb" } }], [{ n75: { spell: "Eb" } }]]);
});

test("the letter keys, ], [ and the octave are not repeated when held, and are not keys on other parts", () => {
  const { press, beats } = sessionOn("pitched");
  expect(press("c", 1000, { repeat: true })).toBe(true);
  expect(beats()).toEqual([]);
  const guitar = sessionOn("fretted");
  for (const key of ["c", "BracketRight", "BracketLeft"]) expect(guitar.press(key), key).toBe(false);
  const drums = sessionOn("percussion");
  for (const key of ["a", "e", "g", "BracketRight"]) expect(drums.press(key), key).toBe(false);
});

test("Delete takes off every note drawn on the cursor's line, C and C♯ together, in one undo step; on a rest it removes the beat", () => {
  const { press, beats } = sessionOn("pitched");
  press("c");
  press("e");
  // Back on C's line: C♯ there too.
  press("ArrowDown");
  press("ArrowDown");
  press("c");
  press("BracketRight");
  press("ArrowUp");
  press("ArrowUp");
  press("e");
  expect(notesOf(beats())).toEqual([{ n73: { spell: "C#" }, n76: { spell: "E" } }]);
  // Two notes on one line: another C, then Delete.
  press("ArrowDown");
  press("ArrowDown");
  press("c");
  expect(notesOf(beats())).toEqual([{ n72: { spell: "C" }, n73: { spell: "C#" }, n76: { spell: "E" } }]);
  press("Delete");
  expect(notesOf(beats())).toEqual([{ n76: { spell: "E" } }]);
  press("ArrowUp");
  press("ArrowUp");
  press("Delete");
  expect(notesOf(beats())).toEqual([{}]);
  press("Delete");
  expect(beats()).toEqual([]);
  press("z", 1000, { ctrlKey: true });
  expect(notesOf(beats())).toEqual([{}]);
  press("z", 1000, { ctrlKey: true });
  expect(notesOf(beats())).toEqual([{ n76: { spell: "E" } }]);
  press("z", 1000, { ctrlKey: true });
  expect(notesOf(beats())).toEqual([{ n72: { spell: "C" }, n73: { spell: "C#" }, n76: { spell: "E" } }]);
});
