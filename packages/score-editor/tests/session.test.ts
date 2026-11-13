// The editor session on its own: which keys it takes on each kind of part, and how it matches them.
import { partsOf, setNote } from "@studio/score-model";
import { expect, test } from "vitest";

import { sessionOn } from "./support";

test.each(["percussion", "pitched"] as const)("digits enter frets only on a fretted part; the other keys work on a %s part", (kind) => {
  const { press, beats, cursor } = sessionOn(kind);
  expect(press("5")).toBe(false);
  expect(beats()).toEqual([]);
  expect(press("Insert")).toBe(true);
  expect(press("+")).toBe(true);
  expect(beats().map((beat) => [beat.value, beat.notes])).toEqual([[8, {}]]);
  expect(press("ArrowDown")).toBe(true);
  expect(cursor().line).toBe(5);
  // A rest: Delete takes the beat away.
  expect(press("Delete")).toBe(true);
  expect(beats()).toEqual([]);
  expect(press("z", 1000, { ctrlKey: true })).toBe(true);
  expect(beats().map((beat) => beat.value)).toEqual([8]);
  expect(press("z", 1000, { ctrlKey: true })).toBe(true);
  expect(beats().map((beat) => beat.value)).toEqual([4]);
});

test.each(["percussion", "pitched"] as const)("on a %s part, Delete leaves a beat with notes alone until its kind gets its note keys", (kind) => {
  const { doc, press, beats, cursor } = sessionOn(kind);
  press("Insert");
  setNote(doc, cursor(), kind === "percussion" ? "p38" : "n60", {});
  const before = beats();
  expect(press("Delete")).toBe(true);
  expect(beats()).toEqual(before);
});

test("shortcuts with a modifier are matched on where the key is, not on what it types", () => {
  const { session, press, beats } = sessionOn();
  press("7");
  // A Russian layout: the key in the place of Z types я.
  expect(session.press({ key: "я", code: "KeyZ", ctrlKey: true })).toBe(true);
  expect(beats()).toEqual([]);
  // A French layout: the key that types z is where W is.
  expect(session.press({ key: "z", code: "KeyW", ctrlKey: true })).toBe(false);
  expect(session.press({ key: "y", code: "KeyY", ctrlKey: true })).toBe(true);
  expect(beats().map((beat) => beat.notes)).toEqual([{ s6: { fret: 7 } }]);
});

test("on a part whose kind cannot be read, digits are not keys and nothing throws", () => {
  const { doc, press, partId } = sessionOn();
  partsOf(doc).get(partId)!.set("kind", "banjo");
  expect(press("5")).toBe(false);
  expect(press("ArrowUp")).toBe(true);
});
