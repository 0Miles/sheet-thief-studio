// Keyboard entry on a fretted part, moved here with the spike's typing (docs/spec/testing.md).
import { cursorAt } from "@studio/score-model";
import { expect, test } from "vitest";

import { TWO_DIGIT_WINDOW } from "../src/index";
import { sessionOn } from "./support";

test("a digit in an empty bar makes a quarter beat with that fret on the cursor's string", () => {
  const { press, beats, cursor } = sessionOn();
  expect(cursor()).toMatchObject({ beatId: null, at: "after" });
  press("7");
  expect(beats().map((beat) => [beat.value, beat.notes])).toEqual([[4, { s6: { fret: 7 } }]]);
  expect(cursor()).toMatchObject({ beatId: beats()[0]!.id, at: "on" });
});

test("→ goes on to the append slot, where a digit appends a beat as long as the one before", () => {
  const { press, beats, cursor } = sessionOn();
  press("7");
  press("+");
  press("ArrowRight");
  expect(cursor()).toMatchObject({ beatId: beats()[0]!.id, at: "after" });
  press("ArrowUp");
  press("9");
  expect(beats().map((beat) => [beat.value, beat.notes])).toEqual([
    [8, { s6: { fret: 7 } }],
    [8, { s5: { fret: 9 } }],
  ]);
  expect(cursor()).toMatchObject({ beatId: beats()[1]!.id, at: "on" });
});

test("two digits typed quickly are one fret; typed slowly, the second replaces the first", () => {
  const { press, beats } = sessionOn();
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

test("a two-digit fret typed in the append slot is one undo step, beat and all", () => {
  const { press, beats } = sessionOn();
  press("1");
  press("5", 100);
  press("ArrowRight");
  press("2");
  press("4", 100);
  expect(beats().map((beat) => beat.notes.s6?.fret)).toEqual([15, 24]);
  press("z", 1000, { ctrlKey: true });
  expect(beats().map((beat) => beat.notes.s6?.fret)).toEqual([15]);
  press("z", 1000, { ctrlKey: true });
  expect(beats()).toEqual([]);
  press("y", 1000, { ctrlKey: true });
  expect(beats().map((beat) => beat.notes.s6?.fret)).toEqual([15]);
});

test("Insert puts a rest before the cursor's beat, as long as it, and appends one in the append slot; each is one undo step", () => {
  const { press, beats, cursor } = sessionOn();
  press("5");
  press("+");
  press("Insert");
  expect(beats().map((beat) => [beat.value, beat.notes])).toEqual([
    [8, {}],
    [8, { s6: { fret: 5 } }],
  ]);
  expect(cursor()).toMatchObject({ beatId: beats()[0]!.id, at: "on" });
  press("ArrowRight");
  press("ArrowRight");
  expect(cursor()).toMatchObject({ beatId: beats()[1]!.id, at: "after" });
  press("Insert");
  expect(beats().map((beat) => [beat.value, beat.notes])).toEqual([
    [8, {}],
    [8, { s6: { fret: 5 } }],
    [8, {}],
  ]);
  expect(cursor()).toMatchObject({ beatId: beats()[2]!.id, at: "on" });
  press("z", 1000, { ctrlKey: true });
  expect(beats()).toHaveLength(2);
  press("z", 1000, { ctrlKey: true });
  expect(beats().map((beat) => beat.notes)).toEqual([{ s6: { fret: 5 } }]);
});

test.each(["Delete", "Backspace"])("%s takes the note off the cursor's string, then, on a rest, the beat; each is one undo step", (key) => {
  const { press, beats, cursor } = sessionOn();
  press("5");
  press("ArrowUp");
  press("3");
  press("ArrowRight");
  press("7");
  const [first, second] = beats().map((beat) => beat.id);
  press("ArrowLeft");
  press(key);
  expect(beats().map((beat) => beat.notes)).toEqual([{ s6: { fret: 5 } }, { s5: { fret: 7 } }]);
  // Nothing on this string: nothing to take off.
  press("ArrowUp");
  press(key);
  expect(beats()[0]!.notes).toEqual({ s6: { fret: 5 } });
  press("ArrowDown");
  press("ArrowDown");
  press(key);
  expect(beats().map((beat) => beat.notes)).toEqual([{}, { s5: { fret: 7 } }]);
  press(key);
  expect(beats().map((beat) => beat.id)).toEqual([second]);
  expect(cursor()).toMatchObject({ beatId: second, at: "on" });

  press("z", 1000, { ctrlKey: true });
  expect(beats().map((beat) => beat.id)).toEqual([first, second]);
  press("z", 1000, { ctrlKey: true });
  expect(beats()[0]!.notes).toEqual({ s6: { fret: 5 } });
  press("z", 1000, { ctrlKey: true });
  expect(beats()[0]!.notes).toEqual({ s6: { fret: 5 }, s5: { fret: 3 } });
});

test("deleting the last beat leaves the cursor in the append slot after the one before, or of the empty voice", () => {
  const { press, beats, cursor } = sessionOn();
  press("Insert");
  press("ArrowRight");
  press("Insert");
  const [first] = beats().map((beat) => beat.id);
  press("Delete");
  expect(cursor()).toMatchObject({ beatId: first, at: "after" });
  press("ArrowLeft");
  press("Delete");
  expect(beats()).toEqual([]);
  expect(cursor()).toMatchObject({ beatId: null, at: "after" });
});

test("no key that moves the cursor makes a transaction, through empty, partly filled, full and overfull bars", () => {
  const { doc, session, press, barIds, partId } = sessionOn("fretted", 4);
  // Bar 1: two quarters; bar 2 empty; bar 3: four quarters; bar 4: a whole and a quarter.
  const filled: [number, number[]][] = [
    [0, [1, 2]],
    [2, [3, 4, 5, 6]],
    [3, [7, 8]],
  ];
  for (const [bar, frets] of filled) {
    session.moveTo(cursorAt(doc, partId, barIds[bar]!, 6));
    for (const fret of frets) {
      press(String(fret));
      press("ArrowRight");
    }
  }
  press("ArrowLeft");
  press("ArrowLeft");
  press("-");
  press("-");
  session.moveTo(cursorAt(doc, partId, barIds[0]!, 6));

  let transactions = 0;
  doc.on("afterTransaction", () => (transactions += 1));
  const places: string[] = [];
  for (const [key, times] of [["ArrowRight", 14], ["ArrowDown", 3], ["ArrowLeft", 14], ["ArrowUp", 8]] as const) {
    for (let i = 0; i < times; i++) {
      expect(press(key)).toBe(true);
      places.push(`${barIds.indexOf(session.cursor!.barId)}:${session.cursor!.at}`);
    }
  }
  expect(transactions).toBe(0);
  // It went through every bar, to the end and back.
  expect(places).toContain("3:on");
  expect(places).toContain("1:after");
  expect(places.at(-1)).toBe("0:on");
});

test("a key that is not a typing key is left alone", () => {
  const { press, beats, cursor } = sessionOn();
  const before = cursor();
  expect(press("a")).toBe(false);
  expect(press("F5")).toBe(false);
  expect(press("c", 1000, { ctrlKey: true })).toBe(false);
  expect(cursor()).toBe(before);
  expect(beats()).toEqual([]);
});
