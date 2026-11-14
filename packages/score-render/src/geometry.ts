// Where a cursor is on the drawn page, and which cursor is under a point: both read alphaTab's
// bounds lookup. Coordinates are those of alphaTab's drawing surface, in CSS pixels.
//
// What alphaTab gives: for every drawn bar of a staff a box whose top edge is the first staff
// line and whose height is the staff (BarBounds.visualBounds), and for every beat its box in x
// plus the x of its notes (BeatBounds.onNotesX). It gives no position for a line without a note,
// so the y of a string or staff position is computed from the top line and the line spacing of
// alphaTab's engraving settings.
import type * as alphaTab from "@coderline/alphatab";
import type { Cursor, PartKind, Selection } from "@studio/score-model";

import { beatIdOf, type Projection } from "./projection";
import type { NoteHead, Rect } from "./types";

type BoundsLookup = alphaTab.rendering.BoundsLookup;
type BarBounds = alphaTab.rendering.BarBounds;
type BeatBounds = alphaTab.rendering.BeatBounds;

/** What the geometry needs to know about a part. */
export interface PartShape {
  kind: PartKind;
  /** Fretted parts: how many strings. */
  strings: number;
}

/** Line spacings of the drawing, already multiplied by its scale. */
export interface StaffMetrics {
  /** Distance between two lines of a five-line staff. */
  staffSpace: number;
  /** Distance between two string lines of a tablature. */
  tabLineSpacing: number;
  /** Thickness of a staff line: the top edge of a bar's box is half of it below the first line's centre. */
  lineThickness: number;
}

/** Half the width of the cursor on a beat with nothing drawn (a rest in tablature), per staff space. */
const MIN_HALF_WIDTH = 0.9;
/** Width of the cursor in the append slot of an empty voice, per staff space. */
const CARET_WIDTH = 0.35;

/** Distance between two cursor lines of a part: a string for tablature, half a staff space otherwise. */
function lineStep(shape: PartShape, metrics: StaffMetrics): number {
  return shape.kind === "fretted" ? metrics.tabLineSpacing : metrics.staffSpace / 2;
}

/** The y offset of the centre of a cursor line from the top of its bar's box. Strings count from 1, staff positions from 0. */
function lineOffset(shape: PartShape, line: number, metrics: StaffMetrics): number {
  return (shape.kind === "fretted" ? line - 1 : line) * lineStep(shape, metrics) - metrics.lineThickness / 2;
}

/** Height of the cursor: a string for tablature, a staff space otherwise. */
function cursorHeight(shape: PartShape, metrics: StaffMetrics): number {
  return shape.kind === "fretted" ? metrics.tabLineSpacing : metrics.staffSpace;
}

/** The drawn beat of a voice of a bar, by its index there. */
function drawnBeat(bar: BarBounds, voice: number, index: number): BeatBounds | undefined {
  return bar.beats.find((item) => item.beat.voice.index === voice && item.beat.index === index);
}

function barBoundsOf(lookup: BoundsLookup, barIndex: number, track: number, staff: number): BarBounds | null {
  const masterBar = lookup.findMasterBarByIndex(barIndex);
  return masterBar?.bars.find((item) => item.bar.staff.track.index === track && item.bar.staff.index === staff) ?? null;
}

/** The box of the cursor on a drawn beat, in x: centred on its notes, at least as wide as a rest's. */
function beatSpan(beat: BeatBounds, metrics: StaffMetrics): { left: number; right: number } {
  const half = Math.max(beat.visualBounds.w / 2, MIN_HALF_WIDTH * metrics.staffSpace);
  return { left: beat.onNotesX - half, right: beat.onNotesX + half };
}

/**
 * The rectangle of a cursor: centred on the notes of its beat and on its line. In the append
 * slot of an empty voice it is a thin caret at the left edge of the place of the beats. In an
 * append slot after a beat (its anchor) it is a thin caret between the anchor and whatever is
 * drawn next in the voice: a beat others appended after the anchor, a rest filling the bar, or
 * the end of the bar (docs/spec/commands.md, section 2). Null when the bar or the part is not
 * drawn.
 */
export function cursorRect(lookup: BoundsLookup, projection: Projection, parts: ReadonlyMap<string, PartShape>, cursor: Cursor, metrics: StaffMetrics): Rect | null {
  const track = projection.partIndex.get(cursor.partId);
  const barIndex = projection.barIndex.get(cursor.barId);
  const shape = parts.get(cursor.partId);
  if (track === undefined || barIndex === undefined || shape === undefined) return null;
  const [staff = 0, voice = 0] = cursor.voice.split(":").map(Number);
  const bar = barBoundsOf(lookup, barIndex, track, staff);
  if (bar === null) return null;

  const height = cursorHeight(shape, metrics);
  const y = bar.visualBounds.y + lineOffset(shape, cursor.line, metrics) - height / 2;

  if (cursor.beatId === null) {
    const first = bar.beats.find((item) => item.beat.voice.index === voice) ?? bar.beats[0];
    const left = first ? first.realBounds.x : bar.visualBounds.x;
    return { x: left, y, width: CARET_WIDTH * metrics.staffSpace, height };
  }
  const address = projection.addresses.get(cursor.beatId);
  if (address === undefined || address.bar !== barIndex) return null;
  const beat = drawnBeat(bar, address.voice, address.beat);
  if (beat === undefined) return null;
  const span = beatSpan(beat, metrics);
  if (cursor.at === "on") return { x: span.left, y, width: span.right - span.left, height };
  const next = drawnBeat(bar, address.voice, address.beat + 1);
  const end = next === undefined ? bar.visualBounds.x + bar.visualBounds.w : beatSpan(next, metrics).left;
  const width = Math.min(CARET_WIDTH * metrics.staffSpace, Math.max(end - span.right, 0));
  return { x: (span.right + end - width) / 2, y, width, height };
}

/** The key of a note of the score as alphaTab has it: strings count from the highest there, from the lowest in alphaTab. */
function noteKeyOf(note: alphaTab.model.Note, shape: PartShape): string {
  if (shape.kind === "fretted") return `s${shape.strings - note.string + 1}`;
  if (shape.kind === "percussion") return `p${note.percussionArticulation}`;
  return `n${note.octave * 12 + note.tone}`;
}

/**
 * The note heads of the beat the cursor is on, where alphaTab reports it drew them (fret numbers,
 * in tablature). Diagnostic: the measurements compare them with `cursorRect`. None in an append
 * slot, or when the beat is not drawn.
 */
export function noteHeads(lookup: BoundsLookup, projection: Projection, parts: ReadonlyMap<string, PartShape>, cursor: Cursor): NoteHead[] {
  const track = projection.partIndex.get(cursor.partId);
  const barIndex = projection.barIndex.get(cursor.barId);
  const shape = parts.get(cursor.partId);
  const address = cursor.beatId === null ? undefined : projection.addresses.get(cursor.beatId);
  if (cursor.at !== "on" || track === undefined || barIndex === undefined || shape === undefined || address === undefined || address.bar !== barIndex) return [];
  const [staff = 0] = cursor.voice.split(":").map(Number);
  const bar = barBoundsOf(lookup, barIndex, track, staff);
  const beat = bar && drawnBeat(bar, address.voice, address.beat);
  return (beat?.notes ?? []).map(({ note, noteHeadBounds: box }) => ({ key: noteKeyOf(note, shape), rect: { x: box.x, y: box.y, width: box.w, height: box.h } }));
}

/** The box around boxes, reaching `margin` above and below them. */
function around(boxes: readonly alphaTab.rendering.Bounds[], margin: number): Rect {
  const left = Math.min(...boxes.map((box) => box.x));
  const right = Math.max(...boxes.map((box) => box.x + box.w));
  const top = Math.min(...boxes.map((box) => box.y)) - margin;
  const bottom = Math.max(...boxes.map((box) => box.y + box.h)) + margin;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Where a selection is drawn (docs/spec/commands.md, section 4): over the staves it is on, and
 * as far above and below them as the cursor on their outer lines (strings or staff lines)
 * reaches. A beat range: one box from its first beat to its last, over the staff of its voice.
 * A bar range: one box for each system it is on, from its first bar there to its last, over
 * every staff of its part. None when its part, bars or beats are not drawn.
 */
export function selectionRects(lookup: BoundsLookup, projection: Projection, parts: ReadonlyMap<string, PartShape>, selection: Selection, metrics: StaffMetrics): Rect[] {
  const track = projection.partIndex.get(selection.partId);
  const shape = parts.get(selection.partId);
  if (track === undefined || shape === undefined) return [];
  // Half the cursor's height (`cursorRect`) past the line's centre, which is half a line thinner than the box's edge.
  const margin = cursorHeight(shape, metrics) / 2 + metrics.lineThickness;
  if (selection.kind === "beats") {
    const barIndex = projection.barIndex.get(selection.barId);
    const [staff = 0] = selection.voice.split(":").map(Number);
    const bar = barIndex === undefined ? null : barBoundsOf(lookup, barIndex, track, staff);
    if (bar === null) return [];
    const drawn = (beatId: string): BeatBounds | undefined => {
      const address = projection.addresses.get(beatId);
      return address === undefined || address.bar !== barIndex ? undefined : drawnBeat(bar, address.voice, address.beat);
    };
    const anchor = drawn(selection.anchorBeatId);
    const focus = drawn(selection.focusBeatId);
    if (anchor === undefined || focus === undefined) return [];
    const [a, b] = [beatSpan(anchor, metrics), beatSpan(focus, metrics)];
    const left = Math.min(a.left, b.left);
    const right = Math.max(a.right, b.right);
    const staffBox = around([bar.visualBounds], margin);
    return [{ ...staffBox, x: left, width: right - left }];
  }
  const anchor = projection.barIndex.get(selection.anchorBarId);
  const focus = projection.barIndex.get(selection.focusBarId);
  if (anchor === undefined || focus === undefined) return [];
  // The staves of the part in each bar, by the system they are drawn on.
  const bySystem = new Map<unknown, alphaTab.rendering.Bounds[]>();
  for (let index = Math.min(anchor, focus); index <= Math.max(anchor, focus); index++) {
    const masterBar = lookup.findMasterBarByIndex(index);
    if (masterBar === null) continue;
    const staves = masterBar.bars.filter((item) => item.bar.staff.track.index === track).map((item) => item.visualBounds);
    if (staves.length === 0) continue;
    const system = bySystem.get(masterBar.staffSystemBounds);
    if (system === undefined) bySystem.set(masterBar.staffSystemBounds, staves);
    else system.push(...staves);
  }
  return [...bySystem.values()].map((boxes) => around(boxes, margin));
}

/**
 * Where playback is on the page, `offset` ticks into a bar (by index): the beat of the top staff
 * drawn that is played then, as tall as the system the bar is on. At the start of a bar it is the
 * bar's first beat, where the cursor stands in the append slot of an empty voice. Null when the
 * bar is not drawn.
 */
export function playbackRect(lookup: BoundsLookup, barIndex: number, offset: number): Rect | null {
  const masterBar = lookup.findMasterBarByIndex(barIndex);
  if (masterBar === null) return null;
  // The bar's box spans its whole system in y, from the top of the system to its bottom.
  const system = masterBar.realBounds;
  // The beats of the first voice: the last of them started by then.
  let played: BeatBounds | undefined;
  for (const beat of masterBar.bars[0]?.beats ?? []) {
    if (beat.beat.voice.index !== 0) continue;
    if (played === undefined || beat.beat.playbackStart <= offset) played = beat;
  }
  const box = played?.realBounds ?? system;
  return { x: box.x, y: system.y, width: box.w, height: system.h };
}

/** alphaTab draws its mark on scores of more than this many bars ... */
const MARK_FREE_BARS = 10;
/** ... or when it draws more than this many tracks (`ScoreLayout._resolveShowAttribution`). */
const MARK_FREE_TRACKS = 2;
/** How wide the mark is at scale 1 (`AttributionGlyph`: about 68.3 px), rounded up. */
const MARK_WIDTH = 70;

/** How much of the score a drawing shows: all its bars, and the tracks drawn. */
export interface DrawnExtent {
  barCount: number;
  trackCount: number;
}

/**
 * The areas no overlay may cover (docs/adr/0003, docs/spec/views.md section 9): where alphaTab
 * draws its attribution mark, above the last bar of the first system, ending at its barline.
 * The mark has no element of its own, so the room above the right end of that bar's top staff is
 * reserved, from the top of the system down to the first staff line, as wide as the mark. None when alphaTab draws no mark: `barCount` bars in the score, `trackCount` tracks drawn.
 */
export function reservedRects(lookup: BoundsLookup, { barCount, trackCount }: DrawnExtent, scale: number): Rect[] {
  if (barCount <= MARK_FREE_BARS && trackCount <= MARK_FREE_TRACKS) return [];
  const system = lookup.staffSystems[0];
  const last = system?.bars.at(-1);
  if (system === undefined || last === undefined) return [];
  const right = last.realBounds.x + last.realBounds.w;
  const left = right - MARK_WIDTH * scale;
  const top = system.realBounds.y;
  const firstLine = Math.min(...last.bars.map((bar) => bar.visualBounds.y));
  return [{ x: left, y: top, width: right - left, height: Math.max(firstLine - top, 0) }];
}

function distanceToSpan(value: number, start: number, length: number): number {
  return value < start ? start - value : value > start + length ? value - (start + length) : 0;
}

/** The cursor nearest to a point: the staff nearest in y of the bar under x, then its nearest beat and line. */
export function cursorAtPoint(lookup: BoundsLookup, projection: Projection, parts: ReadonlyMap<string, PartShape>, x: number, y: number, metrics: StaffMetrics): Cursor | null {
  let best: { bar: BarBounds; distance: number } | null = null;
  for (const system of lookup.staffSystems) {
    if (distanceToSpan(y, system.realBounds.y, system.realBounds.h) > 0) continue;
    for (const masterBar of system.bars) {
      if (distanceToSpan(x, masterBar.realBounds.x, masterBar.realBounds.w) > 0) continue;
      for (const bar of masterBar.bars) {
        const distance = distanceToSpan(y, bar.visualBounds.y, bar.visualBounds.h);
        if (best === null || distance < best.distance) best = { bar, distance };
      }
    }
  }
  if (best === null) return null;
  const bar = best.bar;
  const track = bar.bar.staff.track.index;
  const partId = projection.partIds[track];
  const barId = projection.barIds[bar.bar.index];
  const shape = partId === undefined ? undefined : parts.get(partId);
  if (partId === undefined || barId === undefined || shape === undefined) return null;

  // Only beats of the score can hold the cursor: rests added to fill the bar are skipped.
  let nearest: { beat: BeatBounds; id: string; distance: number } | null = null;
  for (const beat of bar.beats) {
    const id = beatIdOf(projection, beat.beat);
    if (id === null) continue;
    const distance = Math.abs(beat.onNotesX - x);
    if (nearest === null || distance < nearest.distance) nearest = { beat, id, distance };
  }
  const position = Math.round((y - bar.visualBounds.y + metrics.lineThickness / 2) / lineStep(shape, metrics));
  const line = shape.kind === "fretted" ? Math.min(Math.max(position + 1, 1), Math.max(shape.strings, 1)) : position;
  return {
    partId,
    barId,
    voice: `${bar.bar.staff.index}:${nearest?.beat.beat.voice.index ?? 0}`,
    beatId: nearest?.id ?? null,
    // A bar without beats of the score: the append slot of its empty voice.
    at: nearest === null ? "after" : "on",
    line,
  };
}
