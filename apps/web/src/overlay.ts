// What the overlays drawn over the score share: none of them may cover an area the renderer
// reserves (docs/spec/views.md, section 9). An overlay in the way moves, the reserved area stays.
import type { Rect } from "@studio/score-render";

/** The two rectangles share some area; touching edges do not count. */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
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
