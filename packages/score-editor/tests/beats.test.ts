// The keys that change whole beats (docs/spec/commands.md, 5.3 and 5.6): `+`, `-`, `.`,
// Shift+T and Shift+R, at the cursor and over a selection, on one staff, on two, on each kind of
// part, in the first bar and in the last, on both platforms.
import { cursorAt } from "@studio/score-model";
import { expect, test } from "vitest";

import { createEditorSession } from "../src/index";
import { band, PLATFORMS } from "./band";

const shift = { shiftKey: true };
const durations = (beats: { value: number; dots: number; tuplet?: unknown }[]) => beats.map(({ value, dots, tuplet }) => [value, dots, tuplet ?? null]);
const triplet = { actual: 3, normal: 2 };

test.each(PLATFORMS)("on %s, . cycles the dots of the cursor's beat, and each change is one undo step", (platform) => {
  const { press, beats, mods } = band(platform);
  expect(press(".")).toBe(true);
  expect(beats("guitar", 0)[0]).toMatchObject({ value: 2, dots: 1 });
  press(".");
  expect(beats("guitar", 0)[0]!.dots).toBe(2);
  expect(press("NumpadDecimal")).toBe(true);
  expect(beats("guitar", 0)[0]!.dots).toBe(0);
  press("z", mods.mod);
  expect(beats("guitar", 0)[0]!.dots).toBe(2);
  press("z", mods.mod);
  press("z", mods.mod);
  expect(beats("guitar", 0)[0]!.dots).toBe(0);
});

test.each(PLATFORMS)("on %s, Shift+T puts a triplet on the cursor's beat and takes it off again, on one staff of two and on the drums in the last bar", (platform) => {
  const { press, beats, goTo, mods } = band(platform);
  goTo("keys", 0, "1:0");
  expect(press("t", shift)).toBe(true);
  expect(durations(beats("keys", 0, "1:0"))).toEqual([[1, 0, triplet]]);
  goTo("drums", 2);
  press("t", shift);
  expect(durations(beats("drums", 2))).toEqual([[4, 0, triplet]]);
  press("t", shift);
  expect(durations(beats("drums", 2))).toEqual([[4, 0, null]]);
  press("z", mods.mod);
  expect(durations(beats("drums", 2))).toEqual([[4, 0, triplet]]);
  // The other parts are as they were.
  expect(durations(beats("keys", 0))).toEqual([
    [4, 0, null],
    [4, 0, null],
    [4, 0, null],
    [4, 0, null],
  ]);
});

test.each(PLATFORMS)("on %s, Shift+R clears the cursor's beat to a rest, on every kind of part, in one undo step", (platform) => {
  const { press, beats, goTo, mods } = band(platform);
  expect(press("r", shift)).toBe(true);
  expect(beats("guitar", 0).map((beat) => beat.notes)).toEqual([{}, { s1: { fret: 5 } }]);
  goTo("keys", 0, "0:1");
  press("r", shift);
  expect(beats("keys", 0, "0:1")).toMatchObject([{ value: 2, notes: {} }]);
  goTo("drums", 2);
  press("r", shift);
  expect(beats("drums", 2)).toMatchObject([{ value: 4, notes: {} }]);
  press("z", mods.mod);
  expect(beats("drums", 2).map((beat) => beat.notes)).toEqual([{ p38: {} }]);
  // A rest stays one: nothing to undo for it.
  press("r", shift);
  press("r", shift);
  press("z", mods.mod);
  expect(beats("drums", 2).map((beat) => beat.notes)).toEqual([{ p38: {} }]);
});

test("in the append slot, +, -, ., Shift+T and Shift+R change nothing, after a beat or in an empty voice", () => {
  const { press, goTo, doc } = band();
  let transactions = 0;
  doc.on("afterTransaction", () => (transactions += 1));
  const keys = [["+", {}], ["-", {}], [".", {}], ["t", shift], ["r", shift]] as const;
  goTo("guitar", 0, "0:0", 1);
  press("ArrowRight");
  for (const [key, modifiers] of keys) expect(press(key, modifiers)).toBe(true);
  goTo("drums", 1, "0:0", -1);
  for (const [key, modifiers] of keys) expect(press(key, modifiers)).toBe(true);
  expect(transactions).toBe(0);
});

test.each(PLATFORMS)("on %s, over a beat range, +, -, ., Shift+T and Shift+R change every beat in it, one undo step each, and the selection stays", (platform) => {
  const { session, press, beats, goTo, mods } = band(platform);
  goTo("keys", 0);
  press("ArrowRight", shift);
  press("ArrowRight", shift);
  const selected = session.selection;
  expect(selected).toMatchObject({ kind: "beats" });
  const upper = () => durations(beats("keys", 0));
  press("+");
  expect(upper()).toEqual([[8, 0, null], [8, 0, null], [8, 0, null], [4, 0, null]]);
  press(".");
  expect(upper()).toEqual([[8, 1, null], [8, 1, null], [8, 1, null], [4, 0, null]]);
  press("t", shift);
  expect(upper()).toEqual([[8, 1, triplet], [8, 1, triplet], [8, 1, triplet], [4, 0, null]]);
  press("-");
  press("-");
  expect(upper()).toEqual([[2, 1, triplet], [2, 1, triplet], [2, 1, triplet], [4, 0, null]]);
  press("r", shift);
  expect(beats("keys", 0).map((beat) => beat.notes)).toEqual([{}, {}, {}, { n60: {} }]);
  expect(session.selection).toEqual(selected);
  for (let step = 0; step < 6; step++) press("z", mods.mod);
  expect(upper()).toEqual([[4, 0, null], [4, 0, null], [4, 0, null], [4, 0, null]]);
  expect(beats("keys", 0).map((beat) => beat.notes)).toEqual([{ n60: {} }, { n60: {} }, { n60: {} }, { n60: {} }]);
});

test.each(PLATFORMS)("on %s, over a bar range, the keys change every beat of every voice of the part in those bars, the last bar among them, and leave the other parts alone", (platform) => {
  const { press, beats, goTo, mods } = band(platform);
  goTo("keys", 1, "0:0", -1);
  press("ArrowRight", { ...mods.nav, ...shift });
  press("t", shift);
  press("r", shift);
  expect(beats("keys", 2).map((beat) => [beat.notes, beat.tuplet])).toEqual([
    [{}, triplet],
    [{}, triplet],
  ]);
  expect(beats("keys", 0).every((beat) => beat.tuplet === undefined)).toBe(true);
  expect(beats("guitar", 2)).toMatchObject([{ value: 1, notes: { s1: { fret: 5 } } }]);
  expect(beats("drums", 2)).toMatchObject([{ value: 4, notes: { p38: {} } }]);
  // From the first bar, over the lower staff too.
  goTo("keys", 0, "1:0");
  press("ArrowRight", { ...mods.nav, ...shift });
  press(".");
  expect(beats("keys", 0, "1:0").map((beat) => beat.dots)).toEqual([1]);
  expect(beats("keys", 0, "0:1").map((beat) => beat.dots)).toEqual([1]);
  expect(beats("keys", 0).map((beat) => beat.dots)).toEqual([1, 1, 1, 1]);
});

test("while read-only, the keys that change beats change nothing, and the selection stays", () => {
  const { doc, partIds, barIds, session: writer } = band();
  writer.destroy();
  const session = createEditorSession(doc, { platform: "other", cursor: cursorAt(doc, partIds.keys, barIds[0]!), readOnly: true });
  session.press({ code: "ArrowRight", shiftKey: true });
  const before = JSON.stringify(doc.toJSON());
  for (const key of [{ code: "Equal" }, { code: "Minus" }, { code: "Period" }, { code: "KeyT", shiftKey: true }, { code: "KeyR", shiftKey: true }]) expect(session.press(key)).toBe(true);
  expect(JSON.stringify(doc.toJSON())).toBe(before);
  expect(session.selection).toMatchObject({ kind: "beats" });
});
