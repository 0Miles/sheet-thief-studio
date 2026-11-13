// Overlays move out of the reserved areas (docs/spec/views.md, section 9).
import { expect, test } from "vitest";

import { clearOf, overlaps } from "../src/overlay";

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
