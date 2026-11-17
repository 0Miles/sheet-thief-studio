// Where the cursor is drawn and which areas no overlay may cover, read from a real alphaTab layout
// made without a browser (alphaTab lays out and draws SVG in Node).
import * as alphaTab from "@coderline/alphatab";
import { addPart, createScore, type Cursor, cursorAt, docToJson, insertBars, insertBeat, type ScoreJSON, type Selection, setFret, setNote } from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { barRangeRects, cursorRect, noteHeads, type PartShape, playbackRect, reservedRects, selectionRects, type StaffMetrics } from "../src/geometry";
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
    selected: (selection: Selection) => selectionRects(lookup, projection, parts, selection, metrics),
    structural: (anchorBarId: string, focusBarId: string) => barRangeRects(lookup, projection, parts, anchorBarId, focusBarId, metrics),
    reserved: () => reservedRects(lookup, { barCount: score.bars.length, trackCount: tracks.length }, settings.display.scale),
    played: (bar: number, offset: number) => playbackRect(lookup, bar, offset),
    heads: (cursor: Cursor) => noteHeads(lookup, projection, parts, cursor),
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

test("a beat range is drawn as one box around its beats, from the first to the last, over the whole staff of its part", () => {
  const { doc, barIds, partIds } = band(2, 2);
  const partId = partIds[0]!;
  let at = cursorAt(doc, partId, barIds[0]!, 1);
  const beats: Cursor[] = [];
  for (const fret of [1, 2, 3, 4]) {
    at = setFret(doc, beats.length === 0 ? at : { ...at, at: "after" }, fret);
    beats.push(at);
  }
  const drawn = layOut(docToJson(doc));
  const boxes = drawn.selected({ kind: "beats", partId, barId: barIds[0]!, voice: "0:0", anchorBeatId: beats[2]!.beatId!, focusBeatId: beats[0]!.beatId! });
  expect(boxes).toHaveLength(1);
  const box = boxes[0]!;
  for (const line of [1, 6]) for (const beat of beats.slice(0, 3)) expect(contains(box, drawn.rect({ ...beat, line })!), `line ${line}`).toBe(true);
  const fourth = drawn.rect(beats[3]!)!;
  expect(box.x + box.width).toBeLessThanOrEqual(fourth.x);
  // Not over the staff of the other part: short of its first string.
  const below = drawn.rect(cursorAt(doc, partIds[1]!, barIds[0]!, 1))!;
  expect(box.y + box.height).toBeLessThan(below.y + below.height / 2);
});

test("a bar range is drawn as one box for each system it is on, over its part only", () => {
  const { doc, barIds, partIds } = band(12, 2);
  const partId = partIds[1]!;
  const drawn = layOut(docToJson(doc));
  const boxes = drawn.selected({ kind: "bars", partId, anchorBarId: barIds[11]!, focusBarId: barIds[0]! });
  // Twelve bars do not fit on one system of 1200 px.
  expect(boxes.length).toBeGreaterThan(1);
  for (const barId of barIds) {
    const inBar = [1, 6].map((line) => drawn.rect(cursorAt(doc, partId, barId, line))!);
    const holding = boxes.filter((box) => inBar.every((rect) => contains(box, rect)));
    expect(holding).toHaveLength(1);
    // Short of the last string of the part above.
    const above = drawn.rect(cursorAt(doc, partIds[0]!, barId, 6))!;
    expect(holding[0]!.y).toBeGreaterThan(above.y + above.height / 2);
  }
});

test("the bars of a structural command are drawn as one box for each system they are on, over every part drawn", () => {
  const { doc, barIds, partIds } = band(12, 3);
  const drawn = layOut(docToJson(doc), 2);
  const boxes = drawn.structural(barIds[11]!, barIds[0]!);
  expect(boxes.length).toBeGreaterThan(1);
  for (const barId of barIds) {
    // The first string of the first part and the last of the second, the last part drawn.
    const inBar = [drawn.rect(cursorAt(doc, partIds[0]!, barId, 1))!, drawn.rect(cursorAt(doc, partIds[1]!, barId, 6))!];
    expect(boxes.filter((box) => inBar.every((rect) => contains(box, rect)))).toHaveLength(1);
  }
  // One bar: one box, as wide as the bar.
  const [one] = drawn.structural(barIds[1]!, barIds[1]!);
  const inBar = drawn.rect(cursorAt(doc, partIds[0]!, barIds[1]!, 1))!;
  expect(contains(one!, inBar)).toBe(true);
  expect(one!.width).toBeLessThan(boxes[0]!.width);
  expect(drawn.structural("gone", barIds[0]!)).toEqual([]);
});

test("a selection whose part or bars are not drawn has no box", () => {
  const { doc, barIds, partIds } = band(2, 2);
  const drawn = layOut(docToJson(doc), 1);
  expect(drawn.selected({ kind: "bars", partId: partIds[1]!, anchorBarId: barIds[0]!, focusBarId: barIds[1]! })).toEqual([]);
  expect(drawn.selected({ kind: "beats", partId: partIds[0]!, barId: barIds[0]!, voice: "0:0", anchorBeatId: "gone", focusBeatId: "gone" })).toEqual([]);
});

test("on a staff of five lines, the box of a selection holds the cursor on its top and bottom lines", () => {
  const doc = new Y.Doc();
  createScore(doc, "Demo");
  const barIds = insertBars(doc, { after: null, count: 2 });
  const partId = addPart(doc, { name: "Voice", kind: "pitched" });
  const drawn = layOut(docToJson(doc));
  const boxes = drawn.selected({ kind: "bars", partId, anchorBarId: barIds[0]!, focusBarId: barIds[1]! });
  expect(boxes).toHaveLength(1);
  for (const barId of barIds) for (const line of [0, 8]) expect(contains(boxes[0]!, drawn.rect(cursorAt(doc, partId, barId, line))!), `line ${line}`).toBe(true);
});

test("the note heads of the cursor's beat are where alphaTab drew them, each under the cursor on its own string", () => {
  const { doc, barIds, partIds } = band(2, 1);
  const partId = partIds[0]!;
  const beat = setFret(doc, cursorAt(doc, partId, barIds[0]!, 2), 5);
  setNote(doc, { ...beat, line: 5 }, "s5", { fret: 12 });
  const drawn = layOut(docToJson(doc));
  const heads = drawn.heads(beat);
  expect(heads.map((head) => head.key).sort()).toEqual(["s2", "s5"]);
  for (const { key, rect } of heads) {
    const cursor = drawn.rect({ ...beat, line: Number(key.slice(1)) })!;
    const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    expect(centre.x, key).toBeGreaterThanOrEqual(cursor.x);
    expect(centre.x, key).toBeLessThanOrEqual(cursor.x + cursor.width);
    expect(centre.y, key).toBeGreaterThanOrEqual(cursor.y);
    expect(centre.y, key).toBeLessThanOrEqual(cursor.y + cursor.height);
  }
});

test("the note heads of a drum beat and of a pitched beat carry the keys of the score", () => {
  const doc = new Y.Doc();
  createScore(doc, "Demo");
  const barIds = insertBars(doc, { after: null, count: 2 });
  const drums = addPart(doc, { name: "Drums", kind: "percussion" });
  const keys = addPart(doc, { name: "Keys", kind: "pitched" });
  const hit = setNote(doc, insertBeat(doc, cursorAt(doc, drums, barIds[0]!, 3)), "p38", {});
  setNote(doc, hit, "p36", {});
  const chord = setNote(doc, insertBeat(doc, cursorAt(doc, keys, barIds[0]!, 4)), "n61", { spell: "Db" });
  setNote(doc, chord, "n72", {});
  const drawn = layOut(docToJson(doc));
  expect(drawn.heads(hit).map((head) => head.key).sort()).toEqual(["p36", "p38"]);
  expect(drawn.heads(chord).map((head) => head.key).sort()).toEqual(["n61", "n72"]);
});

test("an append slot, a beat not drawn and a part not drawn have no note heads", () => {
  const { doc, barIds, partIds } = band(2, 2);
  const beat = setFret(doc, cursorAt(doc, partIds[0]!, barIds[0]!, 1), 3);
  const hidden = setFret(doc, cursorAt(doc, partIds[1]!, barIds[0]!, 1), 3);
  const drawn = layOut(docToJson(doc), 1);
  expect(drawn.heads({ ...beat, at: "after" })).toEqual([]);
  expect(drawn.heads(cursorAt(doc, partIds[0]!, barIds[1]!, 1))).toEqual([]);
  expect(drawn.heads({ ...beat, beatId: "gone" })).toEqual([]);
  expect(drawn.heads(hidden)).toEqual([]);
});
