// Selecting part of a score (docs/spec/commands.md, section 4): how a selection is extended as
// the cursor moves, and what it holds. Nothing here changes the document.
import * as Y from "yjs";

import type { Cursor, Selection } from "./commands";
import { barsOf, contentOf, ordered, partsOf, type YVoice } from "./schema";

/** How a selection is extended: beat by beat (Shift+←/→), or bar by bar (Shift+Nav+←/→). */
export type SelectionStep = "beat" | "bar";

/** The bar a selection started in. */
function anchorBarOf(selection: Selection): string {
  return selection.kind === "beats" ? selection.barId : selection.anchorBarId;
}

/**
 * The selection once the cursor moved from `from` to `to` with Shift held: `selection` extended,
 * or one started where the cursor was. Its focus follows the cursor. A beat range stays in the
 * voice and the bar it started in; extended past the bar, it becomes the range of bars from the
 * one it started in to the cursor's, and stays one. Unchanged when there is no beat to select
 * (an empty voice at either end of the score).
 */
export function extendSelection(selection: Selection | null, from: Cursor, to: Cursor, step: SelectionStep): Selection | null {
  const anchorBarId = selection === null ? from.barId : anchorBarOf(selection);
  const bars: Selection = { kind: "bars", partId: to.partId, anchorBarId, focusBarId: to.barId };
  if (step === "bar" || selection?.kind === "bars" || to.barId !== anchorBarId) return bars;
  const anchorBeatId = selection === null ? from.beatId : selection.anchorBeatId;
  // In the append slot the cursor's beat is its anchor, the last beat before it.
  if (anchorBeatId === null || to.beatId === null) return selection;
  return { kind: "beats", partId: to.partId, barId: to.barId, voice: to.voice, anchorBeatId, focusBeatId: to.beatId };
}

function voiceOf(doc: Y.Doc, partId: string, barId: string, voice: string): YVoice | undefined {
  const part = partsOf(doc).get(partId);
  return part && contentOf(part).get(barId)?.get(voice);
}

/** The ids from one to the other, both included, in the order of `ids`; none when either is not there. */
function between(ids: readonly string[], a: string, b: string): string[] {
  const start = ids.indexOf(a);
  const end = ids.indexOf(b);
  if (start < 0 || end < 0) return [];
  return ids.slice(Math.min(start, end), Math.max(start, end) + 1);
}

/** The voice of a beat range, and the indexes of its beats there, first to last; none when anything it names is gone. */
export function selectedBeats(doc: Y.Doc, selection: Extract<Selection, { kind: "beats" }>): { voice: YVoice; first: number; last: number } | undefined {
  const voice = voiceOf(doc, selection.partId, selection.barId, selection.voice);
  if (voice === undefined || !barsOf(doc).has(selection.barId)) return undefined;
  const ids = voice.map((beat) => beat.get("id") as string);
  const selected = between(ids, selection.anchorBeatId, selection.focusBeatId);
  if (selected.length === 0) return undefined;
  return { voice, first: ids.indexOf(selected[0]!), last: ids.indexOf(selected.at(-1)!) };
}

/** The bars of a bar range, in the order of the score; none when its part or either end is gone. */
export function selectedBars(doc: Y.Doc, selection: Extract<Selection, { kind: "bars" }>): string[] {
  if (!partsOf(doc).has(selection.partId)) return [];
  return between(ordered(barsOf(doc)), selection.anchorBarId, selection.focusBarId);
}

/**
 * The selection if what it names is still there after a change (an undo, another member's);
 * null once a beat, bar or part it starts or ends on is gone.
 */
export function settleSelection(doc: Y.Doc, selection: Selection): Selection | null {
  const there = selection.kind === "beats" ? selectedBeats(doc, selection) !== undefined : selectedBars(doc, selection).length > 0;
  return there ? selection : null;
}
