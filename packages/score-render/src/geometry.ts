// Where a cursor is on the drawn page, and which cursor is under a point: both read alphaTab's
// bounds lookup. Coordinates are those of alphaTab's drawing surface, in CSS pixels.
//
// What alphaTab gives: for every drawn bar of a staff a box whose top edge is the first staff
// line and whose height is the staff (BarBounds.visualBounds), and for every beat its box in x
// plus the x of its notes (BeatBounds.onNotesX). It gives no position for a line without a note,
// so the y of a string or staff position is computed from the top line and the line spacing of
// alphaTab's engraving settings.
import type * as alphaTab from "@coderline/alphatab";
import type { Cursor, PartKind } from "@studio/score-model";

import { beatIdOf, type Projection } from "./projection";
import type { Rect } from "./types";

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
/** Width of the cursor before the first beat of an empty bar, per staff space. */
const CARET_WIDTH = 0.35;

/** Distance between two cursor lines of a part: a string for tablature, half a staff space otherwise. */
function lineStep(shape: PartShape, metrics: StaffMetrics): number {
  return shape.kind === "fretted" ? metrics.tabLineSpacing : metrics.staffSpace / 2;
}

/** The y offset of the centre of a cursor line from the top of its bar's box. Strings count from 1, staff positions from 0. */
function lineOffset(shape: PartShape, line: number, metrics: StaffMetrics): number {
  return (shape.kind === "fretted" ? line - 1 : line) * lineStep(shape, metrics) - metrics.lineThickness / 2;
}

function barBoundsOf(lookup: BoundsLookup, barIndex: number, track: number, staff: number): BarBounds | null {
  const masterBar = lookup.findMasterBarByIndex(barIndex);
  return masterBar?.bars.find((item) => item.bar.staff.track.index === track && item.bar.staff.index === staff) ?? null;
}

/**
 * The rectangle of a cursor: centred on the notes of its beat and on its line. Before the first
 * beat (an empty bar) it is a thin caret at the left edge of the place of the beats. Null when
 * the bar or the part is not drawn.
 */
export function cursorRect(lookup: BoundsLookup, projection: Projection, parts: ReadonlyMap<string, PartShape>, cursor: Cursor, metrics: StaffMetrics): Rect | null {
  const track = projection.partIndex.get(cursor.partId);
  const barIndex = projection.barIndex.get(cursor.barId);
  const shape = parts.get(cursor.partId);
  if (track === undefined || barIndex === undefined || shape === undefined) return null;
  const [staff = 0, voice = 0] = cursor.voice.split(":").map(Number);
  const bar = barBoundsOf(lookup, barIndex, track, staff);
  if (bar === null) return null;

  const step = lineStep(shape, metrics);
  const height = shape.kind === "fretted" ? step : metrics.staffSpace;
  const y = bar.visualBounds.y + lineOffset(shape, cursor.line, metrics) - height / 2;

  if (cursor.beatId === null) {
    const first = bar.beats.find((item) => item.beat.voice.index === voice) ?? bar.beats[0];
    const left = first ? first.realBounds.x : bar.visualBounds.x;
    return { x: left, y, width: CARET_WIDTH * metrics.staffSpace, height };
  }
  const address = projection.addresses.get(cursor.beatId);
  if (address === undefined || address.bar !== barIndex) return null;
  const beat = bar.beats.find((item) => item.beat.voice.index === address.voice && item.beat.index === address.beat);
  if (beat === undefined) return null;
  const half = Math.max(beat.visualBounds.w / 2, MIN_HALF_WIDTH * metrics.staffSpace);
  return { x: beat.onNotesX - half, y, width: half * 2, height };
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
    line,
  };
}
