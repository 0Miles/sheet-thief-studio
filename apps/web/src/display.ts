// Each member's own display options (docs/spec/views.md, sections 6 and 7): the parts shown and
// the zoom of a score, the same in the three views, and the one part the narrow Read view shows.
// They live in this browser only (localStorage), one entry per score.
import { readStored, writeStored } from "./storage";

/** The zooms offered, 1 being the score's own size. */
export const SCALES: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

export interface DisplayOptions {
  /** Parts hidden by the member: any part not in here is shown, parts added later included. */
  hidden: string[];
  scale: number;
}

/** Where a score's options are stored; the measure suite stores them there before opening it (e2e/measure/editView.ts). */
export const displayKey = (scoreId: string) => `studio.display.${scoreId}`;
const narrowKey = (scoreId: string) => `studio.narrowPart.${scoreId}`;

export function loadDisplay(scoreId: string): DisplayOptions {
  const stored = readStored(displayKey(scoreId)) as Partial<Record<keyof DisplayOptions, unknown>> | null;
  const hidden = Array.isArray(stored?.hidden) ? stored.hidden.filter((id): id is string => typeof id === "string") : [];
  const scale = typeof stored?.scale === "number" && SCALES.includes(stored.scale) ? stored.scale : 1;
  return { hidden, scale };
}

export function saveDisplay(scoreId: string, options: DisplayOptions): void {
  writeStored(displayKey(scoreId), options);
}

/** The parts to show, in the score's order: all but the hidden ones, or all of them when that leaves none. */
export function shownParts(partIds: readonly string[], hidden: readonly string[]): string[] {
  const shown = partIds.filter((id) => !hidden.includes(id));
  return shown.length > 0 ? shown : [...partIds];
}

/** The part the narrow Read view shows: the one chosen last for this score, while it is still there; else the first. */
export function loadNarrowPart(scoreId: string, partIds: readonly string[]): string | null {
  const stored = readStored(narrowKey(scoreId));
  return typeof stored === "string" && partIds.includes(stored) ? stored : (partIds[0] ?? null);
}

export function saveNarrowPart(scoreId: string, partId: string): void {
  writeStored(narrowKey(scoreId), partId);
}
