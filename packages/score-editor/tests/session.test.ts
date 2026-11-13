// The editor session on its own: which keys it takes on each kind of part, and how it matches them.
import { partsOf } from "@studio/score-model";
import { expect, test } from "vitest";

import { sessionOn } from "./support";

test("digits and Delete enter and clear frets only on a fretted part; the other keys work on every kind", () => {
  for (const kind of ["percussion", "pitched"] as const) {
    const { session, press, beats, cursor } = sessionOn(kind);
    expect(press("5")).toBe(false);
    expect(beats()).toEqual([]);
    expect(press("Insert")).toBe(true);
    expect(press("+")).toBe(true);
    expect(beats().map((beat) => [beat.value, beat.notes])).toEqual([[8, {}]]);
    expect(press("Delete")).toBe(false);
    expect(press("ArrowDown")).toBe(true);
    expect(cursor().line).toBe(5);
    expect(press("z", 1000, { ctrlKey: true })).toBe(true);
    expect(beats().map((beat) => beat.value)).toEqual([4]);
    session.destroy();
  }
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
