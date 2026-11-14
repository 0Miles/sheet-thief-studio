// What the overlays drawn over the score share: none of them may cover an area the renderer
// reserves (docs/spec/views.md, section 9). An overlay in the way moves, the reserved area stays.
import type { Flag } from "@studio/score-model";
import type { Rect, ScoreRenderer } from "@studio/score-render";

/** The two rectangles share some area; touching edges do not count. */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The same place, or both none. */
export function sameRect(a: Rect | null, b: Rect | null): boolean {
  return a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
}

/**
 * The rectangle moved out of every reserved area it reaches into. Reserved areas lie above a
 * staff, so it goes below them: what reaches lower than an area is cut at the area's bottom
 * edge, anything else is moved under it.
 */
export function clearOf(rect: Rect, reserved: readonly Rect[]): Rect {
  let clear = rect;
  for (const area of reserved) {
    if (!overlaps(clear, area)) continue;
    const below = area.y + area.height;
    const bottom = clear.y + clear.height;
    clear = bottom > below ? { ...clear, y: below, height: bottom - below } : { ...clear, y: below };
  }
  return clear;
}

/** The size of the box a beat's text is typed in, and how far below the cursor it opens (docs/spec/keymap.md, 6.1). */
export const ENTRY_BOX = { width: 160, height: 28, gap: 4 };

/**
 * Where the box of a beat's text opens: just below the cursor, at its own size, and below every
 * reserved area it would reach into. Moved, never cut as `clearOf` cuts: a box that is shorter
 * than its text cannot be typed in.
 */
export function entryRect(cursor: Rect, reserved: readonly Rect[]): Rect {
  let box: Rect = { x: cursor.x, y: cursor.y + cursor.height + ENTRY_BOX.gap, width: ENTRY_BOX.width, height: ENTRY_BOX.height };
  for (const area of reserved) if (overlaps(box, area)) box = { ...box, y: area.y + area.height };
  return box;
}

/** A flag as drawn (docs/spec/flags.md, section 4): a box on a bar, or a mark on a note. */
export interface FlagMark {
  kind: Flag["kind"];
  shape: "box" | "note";
  rect: Rect;
}

/** The width of a box's stroke: it is drawn inside the box, which is shrunk by half of it. */
export const FLAG_STROKE = 2;
/** How far a note's mark reaches around its head. */
const NOTE_MARGIN = 2;

/** The rectangle made smaller by `by` on every side; null when nothing is left of it. */
function shrink(rect: Rect, by: number): Rect | null {
  const width = rect.width - 2 * by;
  const height = rect.height - 2 * by;
  return width > 0 && height > 0 ? { x: rect.x + by, y: rect.y + by, width, height } : null;
}

/** The rectangle made larger by `by` on every side. */
function grow(rect: Rect, by: number): Rect {
  return { x: rect.x - by, y: rect.y - by, width: rect.width + 2 * by, height: rect.height + 2 * by };
}

/**
 * Where the flags of the parts shown are drawn, each out of the reserved areas: a note's flag
 * (a dangling tie or link) is a mark around its head; one of a bar (underfull, overfull, invalid
 * content in a bar) a box on the bar of its part, or of every part shown when it is the bar's
 * own. Invalid content that has no bar is only counted, in the toolbar.
 */
export function flagMarksOf(
  renderer: Pick<ScoreRenderer, "boundsOfSelection" | "noteHeadsOf">,
  flags: readonly Flag[],
  partIds: readonly string[],
  reserved: readonly Rect[],
): FlagMark[] {
  return flags.flatMap((flag): FlagMark[] => {
    const { kind, barId } = flag;
    if (barId === undefined) return [];
    if (kind === "danglingTie" || kind === "danglingLink") {
      if (!partIds.includes(flag.partId)) return [];
      // The heads of every note of the beat: the line the cursor is given does not matter.
      const head = renderer.noteHeadsOf({ partId: flag.partId, barId, voice: flag.voice, beatId: flag.beatId, at: "on", line: 1 }).find((each) => each.key === flag.noteKey);
      if (head === undefined) return [];
      return [{ kind, shape: "note", rect: clearOf(grow(head.rect, NOTE_MARGIN), reserved) }];
    }
    const parts = flag.partId === undefined ? partIds : partIds.filter((id) => id === flag.partId);
    return parts.flatMap((id) =>
      renderer.boundsOfSelection({ kind: "bars", partId: id, anchorBarId: barId, focusBarId: barId }).flatMap((box) => {
        const rect = shrink(clearOf(box, reserved), FLAG_STROKE / 2);
        return rect === null ? [] : [{ kind, shape: "box" as const, rect }];
      }),
    );
  });
}
