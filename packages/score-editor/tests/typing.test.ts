// Keyboard entry on a fretted part, moved here with the spike's typing (docs/spec/testing.md).
import { expect, test } from "vitest";

import { TWO_DIGIT_WINDOW } from "../src/index";
import { typingOn } from "./support";

test("a digit in an empty bar makes a quarter beat with that fret on the cursor's string", () => {
  const { press, beats, cursor } = typingOn();
  press("7");
  expect(beats().map((beat) => [beat.value, beat.notes])).toEqual([[4, { s6: { fret: 7 } }]]);
  expect(cursor().beatId).toBe(beats()[0]!.id);
});

test("two digits typed quickly are one fret; typed slowly, the second replaces the first", () => {
  const { press, beats } = typingOn();
  press("1");
  press("2", TWO_DIGIT_WINDOW - 50);
  expect(beats()[0]!.notes.s6).toEqual({ fret: 12 });
  press("3", TWO_DIGIT_WINDOW + 50);
  expect(beats()[0]!.notes.s6).toEqual({ fret: 3 });
  // 9 then 9 would be fret 99: the second digit starts over instead.
  press("9");
  press("9", 100);
  expect(beats()[0]!.notes.s6).toEqual({ fret: 9 });
});

test("a two-digit fret is one undo step, and so is the digit that made its beat", () => {
  const { press, beats } = typingOn();
  press("1");
  press("5", 100);
  press("Insert");
  press("2");
  press("4", 100);
  expect(beats().map((beat) => beat.notes.s6?.fret)).toEqual([15, 24]);
  press("z", 1000, { ctrlKey: true });
  expect(beats().map((beat) => beat.notes.s6?.fret)).toEqual([15, undefined]);
  press("z", 1000, { ctrlKey: true });
  expect(beats().map((beat) => beat.notes.s6?.fret)).toEqual([15]);
  press("z", 1000, { ctrlKey: true });
  expect(beats()).toEqual([]);
  press("y", 1000, { ctrlKey: true });
  expect(beats().map((beat) => beat.notes.s6?.fret)).toEqual([15]);
});

test("arrows move the cursor, Insert adds a beat of the same value, + and - change it, Delete clears the string", () => {
  const { press, beats, cursor, barIds } = typingOn();
  press("5");
  press("+");
  press("Insert");
  expect(beats().map((beat) => beat.value)).toEqual([8, 8]);
  press("ArrowUp");
  press("3");
  expect(beats()[1]!.notes).toEqual({ s5: { fret: 3 } });
  press("-");
  press("-");
  expect(beats().map((beat) => beat.value)).toEqual([8, 2]);
  press("ArrowLeft");
  press("ArrowDown");
  press("Delete");
  expect(beats()[0]!.notes).toEqual({});
  press("ArrowRight");
  press("ArrowRight");
  expect([cursor().barId, cursor().beatId]).toEqual([barIds[1], null]);
});

test("a key that is not a typing key is left alone", () => {
  const { press, beats, cursor } = typingOn();
  const before = cursor();
  expect(press("a")).toBe(false);
  expect(press("F5")).toBe(false);
  expect(press("c", 1000, { ctrlKey: true })).toBe(false);
  expect(cursor()).toBe(before);
  expect(beats()).toEqual([]);
});
