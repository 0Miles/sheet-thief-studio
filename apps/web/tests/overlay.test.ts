// Overlays move out of the reserved areas (docs/spec/views.md, section 9).
import type { Cursor, Flag, Selection } from "@studio/score-model";
import type { NoteHead } from "@studio/score-render";
import { expect, test } from "vitest";

import { clearOf, clearPieces, ENTRY_BOX, entryRect, flagMarksOf, overlaps, STRUCTURE_STROKE, structuralEnds, structureBoxesOf } from "../src/overlay";

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

test("a box over a whole system is cut only under an area: the rest of it keeps its height", () => {
  const system = { x: 0, y: 35, width: 400, height: 60 };
  expect(clearPieces(system, [AREA])).toEqual([
    { x: 0, y: 35, width: 200, height: 60 },
    { x: 200, y: 40, width: 100, height: 55 },
    { x: 300, y: 35, width: 100, height: 60 },
  ]);
  // Clear of every area, or reaching the area at one end only: one piece, or two.
  expect(clearPieces({ ...system, y: 40 }, [AREA])).toEqual([{ ...system, y: 40 }]);
  expect(clearPieces({ x: 250, y: 35, width: 150, height: 60 }, [AREA])).toEqual([
    { x: 250, y: 40, width: 50, height: 55 },
    { x: 300, y: 35, width: 100, height: 60 },
  ]);
  const areas = [AREA, { x: 20, y: 0, width: 30, height: 45 }];
  const pieces = clearPieces(system, areas);
  expect(pieces).toHaveLength(5);
  for (const piece of pieces) for (const area of areas) expect(overlaps(piece, area)).toBe(false);
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

// Structural boxes (docs/spec/commands.md, section 6): dashed over every part, for a bar range, or the panel of the cursor's bar.

test("a bar range is drawn over every part; with the panel open, a beat range's bar or the cursor's bar is too", () => {
  const cursor: Cursor = { partId: "p", barId: "c", voice: "0:0", beatId: null, at: "after", line: 1 };
  const bars: Selection = { kind: "bars", partId: "p", anchorBarId: "a", focusBarId: "z" };
  const beats: Selection = { kind: "beats", partId: "p", barId: "b", voice: "0:0", anchorBeatId: "x", focusBeatId: "y" };
  expect(structuralEnds(bars, cursor, false)).toEqual(["a", "z"]);
  expect(structuralEnds(bars, cursor, true)).toEqual(["a", "z"]);
  expect(structuralEnds(beats, cursor, false)).toBeNull();
  expect(structuralEnds(beats, cursor, true)).toEqual(["b", "b"]);
  expect(structuralEnds(null, cursor, false)).toBeNull();
  expect(structuralEnds(null, cursor, true)).toEqual(["c", "c"]);
  expect(structuralEnds(null, null, true)).toBeNull();
});

test("a structural box keeps out of the reserved areas, its stroke inside it", () => {
  const asked: [string, string][] = [];
  const renderer = {
    boundsOfBars: (anchor: string, focus: string) => {
      asked.push([anchor, focus]);
      return [{ x: 250, y: 30, width: 100, height: 60 }];
    },
  };
  expect(structureBoxesOf(renderer, null, [AREA])).toEqual([]);
  const half = STRUCTURE_STROKE / 2;
  expect(structureBoxesOf(renderer, ["a", "z"], [AREA])).toEqual([{ x: 250 + half, y: 40 + half, width: 100 - 2 * half, height: 50 - 2 * half }]);
  expect(asked).toEqual([["a", "z"]]);
});
