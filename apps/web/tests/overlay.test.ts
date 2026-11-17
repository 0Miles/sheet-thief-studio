// Overlays move out of the reserved areas (docs/spec/views.md, section 9).
import type { Cursor, Flag, Selection } from "@studio/score-model";
import type { NoteHead } from "@studio/score-render";
import { expect, test } from "vitest";

import { clearOf, ENTRY_BOX, entryRect, flagMarksOf, overlaps } from "../src/overlay";

/** A reserved area 100 px wide above a staff whose first line is at y 40. */
const AREA = { x: 200, y: 10, width: 100, height: 30 };

test("rectangles that only touch do not overlap; any shared area does", () => {
  expect(overlaps(AREA, { x: 300, y: 10, width: 20, height: 30 })).toBe(false);
  expect(overlaps(AREA, { x: 180, y: 10, width: 20, height: 30 })).toBe(false);
  expect(overlaps(AREA, { x: 250, y: 40, width: 10, height: 10 })).toBe(false);
  expect(overlaps(AREA, { x: 250, y: 0, width: 10, height: 10 })).toBe(false);
  expect(overlaps(AREA, { x: 299, y: 39, width: 10, height: 10 })).toBe(true);
});

test("a rectangle clear of every area stays where it is", () => {
  const cursor = { x: 250, y: 40, width: 10, height: 10 };
  expect(clearOf(cursor, [AREA])).toEqual(cursor);
  expect(clearOf(cursor, [])).toEqual(cursor);
});

test("a rectangle that reaches into an area from below is cut at the area's bottom edge", () => {
  expect(clearOf({ x: 250, y: 35, width: 10, height: 10 }, [AREA])).toEqual({ x: 250, y: 40, width: 10, height: 5 });
});

test("a rectangle inside an area moves below it, its size kept", () => {
  expect(clearOf({ x: 250, y: 15, width: 10, height: 10 }, [AREA])).toEqual({ x: 250, y: 40, width: 10, height: 10 });
});

// Flags on the page (docs/spec/flags.md, section 4): a box on a bar, a mark on a note, out of the reserved areas.

/** A renderer that draws bar "b" of every part, and the notes on strings 2 and 3 of beat "x"; it keeps the selections it is asked for. */
function drawing() {
  const asked: Selection[] = [];
  const renderer = {
    boundsOfSelection: (selection: Selection) => {
      asked.push(selection);
      return selection.kind === "bars" && selection.anchorBarId === "b" ? [{ x: 220, y: 20, width: 60, height: 80 }] : [];
    },
    noteHeadsOf: (cursor: Cursor): NoteHead[] =>
      cursor.beatId === "x"
        ? [
            { key: "s2", rect: { x: 200, y: 0, width: 8, height: 10 } },
            { key: "s3", rect: { x: 240, y: 60, width: 8, height: 10 } },
          ]
        : [],
  };
  return { renderer, asked };
}

test("a bar's flag is a box on it, its stroke inside what is kept clear of the reserved areas", () => {
  const { renderer, asked } = drawing();
  const flags: Flag[] = [{ kind: "underfull", partId: "g", barId: "b", voice: "0:0" }];
  expect(flagMarksOf(renderer, flags, ["g"], [AREA])).toEqual([{ kind: "underfull", shape: "box", rect: { x: 221, y: 41, width: 58, height: 58 } }]);
  expect(asked).toEqual([{ kind: "bars", partId: "g", anchorBarId: "b", focusBarId: "b" }]);
  // A part not shown is not drawn on.
  expect(flagMarksOf(renderer, flags, ["h"], [AREA])).toEqual([]);
});

test("a note's flag is a mark around its head; invalid content in a bar is a box on that bar in every part shown, or in its own part", () => {
  const { renderer } = drawing();
  const flags: Flag[] = [
    { kind: "danglingTie", partId: "g", barId: "b", voice: "0:0", beatId: "x", noteKey: "s3" },
    { kind: "danglingTie", partId: "g", barId: "b", voice: "0:0", beatId: "gone", noteKey: "s3" },
    { kind: "invalidContent", barId: "b", what: "bar.timeSig" },
    { kind: "invalidContent", partId: "h", what: "part.name" },
  ];
  expect(flagMarksOf(renderer, flags, ["g", "h"], [])).toEqual([
    { kind: "danglingTie", shape: "note", rect: { x: 238, y: 58, width: 12, height: 14 } },
    { kind: "invalidContent", shape: "box", rect: { x: 221, y: 21, width: 58, height: 78 } },
    { kind: "invalidContent", shape: "box", rect: { x: 221, y: 21, width: 58, height: 78 } },
  ]);
});

// The box of a beat's text (docs/spec/keymap.md, 6.1): below the cursor, out of the reserved areas.

test("the box of a beat's text opens just below the cursor, at its own size, when nothing is reserved there", () => {
  const cursor = { x: 250, y: 60, width: 10, height: 10 };
  expect(entryRect(cursor, [AREA])).toEqual({ x: 250, y: 74, width: ENTRY_BOX.width, height: ENTRY_BOX.height });
  expect(ENTRY_BOX.height).toBe(28);
});

test("a box of a beat's text that would open into a reserved area opens below it, its height kept", () => {
  // The cursor's bottom at y 10: the box would open at y 14, inside the area, and reach to y 42, past its bottom edge.
  const cursor = { x: 250, y: 0, width: 10, height: 10 };
  const box = entryRect(cursor, [AREA]);
  expect(overlaps(box, AREA)).toBe(false);
  expect(box).toEqual({ x: 250, y: AREA.y + AREA.height, width: ENTRY_BOX.width, height: 28 });
  // Two areas one under the other: below both.
  const lower = { x: 200, y: 40, width: 100, height: 20 };
  const below = entryRect(cursor, [AREA, lower]);
  expect([overlaps(below, AREA), overlaps(below, lower), below.y, below.height]).toEqual([false, false, 60, 28]);
});
