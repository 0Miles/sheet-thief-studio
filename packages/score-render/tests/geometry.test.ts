// Where the cursor is drawn and which areas no overlay may cover, read from a real alphaTab layout
// made without a browser (alphaTab lays out and draws SVG in Node).
import * as alphaTab from "@coderline/alphatab";
import { addPart, createScore, type Cursor, cursorAt, docToJson, insertBars, insertBeat, type ScoreJSON, setFret } from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { cursorRect, type PartShape, playbackRect, reservedRects, type StaffMetrics } from "../src/geometry";
import { projectScore } from "../src/projection";
import type { Rect } from "../src/types";

/** The part of alphaTab's layout that holds its attribution mark: not public, read here to check against. */
interface MarkedLayout {
  layout: {
    systems: {
      x: number;
      y: number;
      allStaves: { x: number; y: number; barRenderers: { x: number; y: number; attribution: { x: number; y: number; width: number; height: number } | null }[] }[];
    }[];
  };
}

/** Lay a score out as the edit view does (Page layout, 1200 px wide), showing the first `shown` parts. */
function layOut(score: ScoreJSON, shown = score.parts.length) {
  const settings = new alphaTab.Settings();
  settings.core.engine = "svg";
  settings.core.includeNoteBounds = true;
  settings.display.layoutMode = alphaTab.LayoutMode.Page;
  settings.notation.rhythmMode = alphaTab.TabRhythmMode.ShowWithBars;
  const projection = projectScore(score, settings);
  const renderer = new alphaTab.rendering.ScoreRenderer(settings);
  renderer.width = 1200;
  const tracks = score.parts.slice(0, shown).map((_, index) => index);
  renderer.renderScore(projection.score, tracks);
  const engraving = settings.display.resources.engravingSettings;
  const metrics: StaffMetrics = { staffSpace: engraving.oneStaffSpace, tabLineSpacing: engraving.tabLineSpacing, lineThickness: engraving.staffLineThickness };
  const parts = new Map<string, PartShape>(score.parts.map((part) => [part.id, { kind: part.kind, strings: part.tuning.length }]));
  const lookup = renderer.boundsLookup!;
  /** Where alphaTab put its mark, on the page; null when it drew none. */
  function mark(): Rect | null {
    for (const system of (renderer as unknown as MarkedLayout).layout.systems) {
      for (const staff of system.allStaves) {
        for (const bar of staff.barRenderers) {
          const glyph = bar.attribution;
          if (glyph === null) continue;
          return { x: system.x + staff.x + bar.x + glyph.x, y: system.y + staff.y + bar.y + glyph.y, width: glyph.width, height: glyph.height };
        }
      }
    }
    return null;
  }
  return {
    mark,
    rect: (cursor: Cursor) => cursorRect(lookup, projection, parts, cursor, metrics),
    reserved: () => reservedRects(lookup, { barCount: score.bars.length, trackCount: tracks.length }, settings.display.scale),
    played: (bar: number, offset: number) => playbackRect(lookup, bar, offset),
  };
}

function band(bars: number, parts: number) {
  const doc = new Y.Doc();
  createScore(doc, "Demo");
  const barIds = insertBars(doc, { after: null, count: bars });
  const partIds = Array.from({ length: parts }, (_, index) => addPart(doc, { name: `Guitar ${index + 1}`, kind: "fretted" }));
  return { doc, barIds, partIds };
}

function contains(outer: Rect, inner: Rect): boolean {
  return outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height;
}

test.each([
  [12, 1, 1],
  [11, 2, 2],
  [10, 3, 3],
  [12, 3, 1],
])("with %i bars and %i parts, %i shown, the reserved area holds the mark the engine draws", (bars, parts, shown) => {
  const { doc } = band(bars, parts);
  const drawn = layOut(docToJson(doc), shown);
  const mark = drawn.mark();
  expect(mark).not.toBeNull();
  const reserved = drawn.reserved();
  expect(reserved).toHaveLength(1);
  expect(contains(reserved[0]!, mark!)).toBe(true);
});

test.each([
  [10, 1],
  [10, 2],
])("with %i bars and %i parts the engine draws no mark, and nothing is reserved", (bars, parts) => {
  const { doc } = band(bars, parts);
  const drawn = layOut(docToJson(doc));
  expect(drawn.mark()).toBeNull();
  expect(drawn.reserved()).toEqual([]);
});

test("the append slot is drawn after its anchor, and before the beats others appended after it", () => {
  const { doc, barIds, partIds } = band(2, 1);
  const partId = partIds[0]!;
  // This member's beat, the anchor of their append slot; then a beat someone else appended after it.
  const anchor = setFret(doc, cursorAt(doc, partId, barIds[0]!, 2), 5);
  const theirs = setFret(doc, insertBeat(doc, { ...anchor, at: "after" }), 7);
  const slot: Cursor = { ...anchor, at: "after" };
  const drawn = layOut(docToJson(doc));

  const onAnchor = drawn.rect(anchor)!;
  const onTheirs = drawn.rect(theirs)!;
  const inSlot = drawn.rect(slot)!;
  expect(inSlot).not.toBeNull();
  expect(inSlot.x).toBeGreaterThanOrEqual(onAnchor.x + onAnchor.width);
  expect(inSlot.x + inSlot.width).toBeLessThanOrEqual(onTheirs.x);
  // On the line of the cursor, as on a beat.
  expect(inSlot.y).toBe(onAnchor.y);
  expect(inSlot.height).toBe(onAnchor.height);
});

test("the append slot after the last beat of a bar not full is drawn after that beat, inside the bar", () => {
  const { doc, barIds, partIds } = band(2, 1);
  const anchor = setFret(doc, cursorAt(doc, partIds[0]!, barIds[0]!, 1), 3);
  const drawn = layOut(docToJson(doc));
  const onAnchor = drawn.rect(anchor)!;
  const inSlot = drawn.rect({ ...anchor, at: "after" })!;
  const next = drawn.rect(cursorAt(doc, partIds[0]!, barIds[1]!, 1))!;
  expect(inSlot.x).toBeGreaterThanOrEqual(onAnchor.x + onAnchor.width);
  expect(inSlot.x + inSlot.width).toBeLessThanOrEqual(next.x);
});

test("at the start of every bar, playback is drawn where the cursor is in that empty bar, and as tall as its system", () => {
  const { doc, barIds, partIds } = band(12, 2);
  const drawn = layOut(docToJson(doc));
  const tops = new Set<number>();
  barIds.forEach((barId, index) => {
    const played = drawn.played(index, 0)!;
    expect(played, `bar ${index + 1}`).not.toBeNull();
    // The append slot of the empty voice: at the left edge of the place of the beats.
    const first = drawn.rect(cursorAt(doc, partIds[0]!, barId, 1))!;
    const last = drawn.rect(cursorAt(doc, partIds[1]!, barId, 6))!;
    expect(played.x).toBeCloseTo(first.x, 3);
    expect(played.y).toBeLessThanOrEqual(first.y);
    expect(played.y + played.height).toBeGreaterThanOrEqual(last.y + last.height);
    tops.add(played.y);
  });
  // Twelve bars do not fit on one system of 1200 px.
  expect(tops.size).toBeGreaterThan(1);
});

test("further into a bar, playback is drawn on the beat played then", () => {
  const { doc, barIds, partIds } = band(2, 1);
  const first = insertBeat(doc, cursorAt(doc, partIds[0]!, barIds[0]!, 1), { value: 2 });
  setFret(doc, first, 3);
  const second = setFret(doc, insertBeat(doc, { ...first, at: "after" }, { value: 2 }), 5);
  const drawn = layOut(docToJson(doc));
  const centre = (rect: Rect) => rect.x + rect.width / 2;
  const inside = (rect: Rect, x: number) => rect.x <= x && x <= rect.x + rect.width;

  // A half note is 1920 ticks.
  expect(inside(drawn.played(0, 0)!, centre(drawn.rect(first)!))).toBe(true);
  expect(inside(drawn.played(0, 1919)!, centre(drawn.rect(first)!))).toBe(true);
  expect(inside(drawn.played(0, 1920)!, centre(drawn.rect(second)!))).toBe(true);
  expect(inside(drawn.played(0, 1920)!, centre(drawn.rect(first)!))).toBe(false);
});

test("a bar that is not drawn has no place for playback", () => {
  const { doc } = band(2, 1);
  expect(layOut(docToJson(doc)).played(2, 0)).toBeNull();
});
