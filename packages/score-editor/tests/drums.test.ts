// Typing on drums (docs/spec/keymap.md, 4.2; docs/spec/commands.md, 5.1, 5.2 and 5.4): a letter or
// a digit turns its piece on and off at the cursor, Delete takes every piece off the cursor's line,
// ↑ and ↓ move over the staff positions, Shift+G and Shift+A change the pieces on the line.
import { DRUM_PIECES, setNote } from "@studio/score-model";
import { expect, test } from "vitest";

import { PLATFORMS } from "./band";
import { sessionOn, undoEach } from "./support";

const shift = { shiftKey: true };
const notesOf = (beats: { notes: object }[]) => beats.map((beat) => beat.notes);

test.each(PLATFORMS)("on %s, a piece's key in the append slot makes a beat with it; pressed again it takes the piece off; one undo step each", (platform) => {
  const { press, beats, cursor } = sessionOn("percussion", 2, platform);
  expect(press("k")).toBe(true);
  expect(notesOf(beats())).toEqual([{ p36: {} }]);
  // On the new beat, on the kick's line.
  expect(cursor()).toMatchObject({ beatId: beats()[0]!.id, at: "on", line: DRUM_PIECES.kick.line });
  press("k");
  expect(notesOf(beats())).toEqual([{}]);
  undoEach(press, platform, () => notesOf(beats()), [[{ p36: {} }], []]);
});

test("K, H, →, S, H: two beats, kick and hi-hat, then snare and hi-hat", () => {
  const { press, beats, cursor } = sessionOn("percussion");
  for (const key of ["k", "h", "ArrowRight", "s", "h"]) press(key);
  expect(notesOf(beats())).toEqual([
    { p36: {}, p42: {} },
    { p38: {}, p42: {} },
  ]);
  expect(cursor()).toMatchObject({ beatId: beats()[1]!.id, at: "on", line: DRUM_PIECES.hiHatClosed.line });
});

test("each of the 18 pieces has its key, on the row of digits and the numeric keypad for the toms", () => {
  const { press, beats } = sessionOn("percussion");
  const keys: [string, keyof typeof DRUM_PIECES][] = [
    ["k", "kick"],
    ["s", "snare"],
    ["d", "sideStick"],
    ["f", "rimShot"],
    ["h", "hiHatClosed"],
    ["j", "hiHatHalf"],
    ["o", "hiHatOpen"],
    ["p", "hiHatPedal"],
    ["1", "tomHigh"],
    ["2", "tomMid"],
    ["3", "tomLow"],
    ["Numpad4", "tomFloor"],
    ["c", "crash"],
    ["r", "ride"],
    ["b", "rideBell"],
    ["n", "china"],
    ["m", "splash"],
    ["w", "cowbell"],
  ];
  for (const [key] of keys) expect(press(key), key).toBe(true);
  expect(Object.keys(beats()[0]!.notes).sort()).toEqual(keys.map(([, piece]) => `p${DRUM_PIECES[piece].id}`).sort());
  for (const key of ["Numpad1", "Numpad2", "Numpad3", "4"]) press(key);
  expect(Object.keys(beats()[0]!.notes)).toHaveLength(14);
});

test.each(PLATFORMS)("on %s, Delete on a line takes off every piece drawn there, in one undo step, and leaves the others", (platform) => {
  const { press, beats, cursor } = sessionOn("percussion", 2, platform);
  for (const key of ["s", "h", "o", "c"]) press(key);
  // From the crash's line to the hi-hats'.
  press("ArrowDown");
  expect(cursor().line).toBe(DRUM_PIECES.hiHatClosed.line);
  press("Delete");
  expect(notesOf(beats())).toEqual([{ p38: {}, p49: {} }]);
  undoEach(press, platform, () => notesOf(beats()), [[{ p38: {}, p42: {}, p46: {}, p49: {} }]]);
});

test("Delete on a line no piece is drawn on leaves the beat as it is; on a rest it removes the beat", () => {
  const { press, beats, cursor } = sessionOn("percussion");
  press("s");
  press("ArrowUp");
  press("Delete");
  expect(notesOf(beats())).toEqual([{ p38: {} }]);
  press("ArrowDown");
  press("Delete");
  expect(notesOf(beats())).toEqual([{}]);
  press("Delete");
  expect(beats()).toEqual([]);
  expect(cursor()).toMatchObject({ beatId: null, at: "after" });
});

test("a piece the interface does not offer has no line: Delete leaves it, Shift+R clears it", () => {
  const { doc, press, beats, cursor } = sessionOn("percussion");
  press("k");
  // An acoustic kick, as an import may bring: alphaTab draws it a step below the kick.
  setNote(doc, cursor(), "p35", {});
  // On the kick's line, only the kick comes off.
  press("Delete");
  expect(notesOf(beats())).toEqual([{ p35: {} }]);
  // On the line alphaTab draws it on, the beat is not a rest: Delete does nothing.
  press("ArrowDown");
  press("Delete");
  expect(notesOf(beats())).toEqual([{ p35: {} }]);
  press("r", 1000, shift);
  expect(notesOf(beats())).toEqual([{}]);
});

test("↑ and ↓ move over the staff positions, from 12 below the staff to -4 above it, and stop there", () => {
  const { press, cursor } = sessionOn("percussion");
  expect(cursor().line).toBe(4);
  for (let step = 0; step < 20; step++) press("ArrowDown");
  expect(cursor().line).toBe(12);
  for (let step = 0; step < 20; step++) press("ArrowUp");
  expect(cursor().line).toBe(-4);
});

test.each(PLATFORMS)("on %s, Shift+G and Shift+A turn ghost and accent on and off on every piece of the cursor's line, one undo step each", (platform) => {
  const { press, beats } = sessionOn("percussion", 2, platform);
  for (const key of ["k", "s", "f"]) press(key);
  // The cursor is on the rim shot's line, the snare's too.
  expect(press("g", 1000, shift)).toBe(true);
  expect(notesOf(beats())).toEqual([{ p36: {}, p38: { ghost: true }, p91: { ghost: true } }]);
  press("a", 1000, shift);
  expect(notesOf(beats())).toEqual([{ p36: {}, p38: { ghost: true, accent: true }, p91: { ghost: true, accent: true } }]);
  press("g", 1000, shift);
  expect(notesOf(beats())).toEqual([{ p36: {}, p38: { accent: true }, p91: { accent: true } }]);
  undoEach(press, platform, () => notesOf(beats())[0], [
    { p36: {}, p38: { ghost: true, accent: true }, p91: { ghost: true, accent: true } },
    { p36: {}, p38: { ghost: true }, p91: { ghost: true } },
  ]);
});

test("a ghost piece pressed again comes off with its ghost; Shift+G on an empty line and in the append slot does nothing, nor does Shift+L", () => {
  const { doc, press, beats } = sessionOn("percussion");
  let transactions = 0;
  doc.on("afterTransaction", () => (transactions += 1));
  press("g", 1000, shift);
  expect(transactions).toBe(0);
  press("s");
  press("g", 1000, shift);
  press("s");
  expect(notesOf(beats())).toEqual([{}]);
  press("s");
  expect(notesOf(beats())).toEqual([{ p38: {} }]);
  press("ArrowUp");
  transactions = 0;
  press("g", 1000, shift);
  press("a", 1000, shift);
  press("l", 1000, shift);
  expect(transactions).toBe(0);
  expect(notesOf(beats())).toEqual([{ p38: {} }]);
});
