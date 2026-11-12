// Moving the cursor through a score. Nothing here changes the document.
import type * as Y from "yjs";

import type { Cursor } from "./commands";
import { barsOf, contentOf, ordered, type PartKind, partsOf, type YVoice } from "./schema";

function voiceOf(doc: Y.Doc, cursor: Cursor, barId = cursor.barId): YVoice | undefined {
  const part = partsOf(doc).get(cursor.partId);
  return part && contentOf(part).get(barId)?.get(cursor.voice);
}

function beatIds(voice: YVoice | undefined): string[] {
  return voice ? voice.map((beat) => beat.get("id") as string) : [];
}

/**
 * The cursor one beat later (`step` 1) or earlier (-1). Past the end of a bar it goes to the
 * first beat of the next one, before its start to the last beat of the one before; in an empty
 * bar it stands before the first beat. At either end of the score it stays where it is.
 */
export function moveByBeat(doc: Y.Doc, cursor: Cursor, step: 1 | -1): Cursor {
  const ids = beatIds(voiceOf(doc, cursor));
  const at = cursor.beatId === null ? -1 : ids.indexOf(cursor.beatId);
  const target = at + step;
  // From before the first beat, a step forward lands on it (index 0), like any other step.
  if (target >= 0 && target < ids.length) return { ...cursor, beatId: ids[target] as string };
  const order = ordered(barsOf(doc));
  const barId = order[order.indexOf(cursor.barId) + step];
  if (barId === undefined) return cursor;
  const others = beatIds(voiceOf(doc, cursor, barId));
  return { ...cursor, barId, beatId: (step === 1 ? others[0] : others.at(-1)) ?? null };
}

/** How many lines the cursor can stand on in a part: its strings when fretted, else the staff positions of a five-line staff with two ledger lines each side. */
function lineRange(kind: PartKind, strings: number): { first: number; last: number } {
  return kind === "fretted" ? { first: 1, last: Math.max(strings, 1) } : { first: -4, last: 12 };
}

/** The cursor one line lower on the page (`step` 1) or higher (-1), kept on the staff. */
export function moveByLine(doc: Y.Doc, cursor: Cursor, step: 1 | -1): Cursor {
  const part = partsOf(doc).get(cursor.partId);
  if (part === undefined) return cursor;
  const { first, last } = lineRange(part.get("kind") as PartKind, (part.get("tuning") as number[]).length);
  return { ...cursor, line: Math.min(Math.max(cursor.line + step, first), last) };
}

/**
 * The cursor if its beat still exists; otherwise the nearest place that does (its beat was
 * removed by an undo or by another member): the last beat of its bar, or before the first.
 * Null when its part or its bar is gone.
 */
export function settleCursor(doc: Y.Doc, cursor: Cursor): Cursor | null {
  const voice = voiceOf(doc, cursor);
  if (voice === undefined || barsOf(doc).has(cursor.barId) === false) return null;
  const ids = beatIds(voice);
  if (cursor.beatId !== null && ids.includes(cursor.beatId)) return cursor;
  if (cursor.beatId === null) return cursor;
  return { ...cursor, beatId: ids.at(-1) ?? null };
}
