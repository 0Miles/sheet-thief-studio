// Moving the cursor through a score (docs/spec/commands.md, section 3). Nothing here changes the
// document: no move opens a transaction.
import * as Y from "yjs";

import type { Cursor } from "./commands";
import { barTicks, beatTicks, fillOf } from "./flags";
import { barsOf, COMMON_TIME, durationOf, ordered, type PartKind, partsOf, stringCountOf, timeSigSchema, voiceIn, type YVoice } from "./schema";

function voiceOf(doc: Y.Doc, cursor: Cursor, barId = cursor.barId): YVoice | undefined {
  return voiceIn(doc, { ...cursor, barId });
}

function beatIds(voice: YVoice | undefined): string[] {
  return voice ? voice.map((beat) => beat.get("id") as string) : [];
}

/** Whether the beats of the cursor's voice add up to less than its bar: then its append slot can be reached by →. */
function isUnderfull(doc: Y.Doc, cursor: Cursor): boolean {
  const timeSig = timeSigSchema.safeParse(barsOf(doc).get(cursor.barId)?.get("timeSig"));
  let held = 0;
  // A beat whose length cannot be read is left out, as reading leaves it out.
  voiceOf(doc, cursor)?.forEach((beat) => {
    const duration = durationOf(beat);
    if (duration !== undefined) held += beatTicks(duration);
  });
  return fillOf(held, barTicks(timeSig.success ? timeSig.data : COMMON_TIME)) === "underfull";
}

/**
 * Where the cursor enters the bar after (`step` 1) or before (-1) its own: the first beat of its
 * voice there going forward, the last going back, unless `entry` says which; the append slot of
 * an empty voice. The cursor itself at either end of the score.
 */
function toNextBar(doc: Y.Doc, cursor: Cursor, step: 1 | -1, entry: "first" | "last" = step === 1 ? "first" : "last"): Cursor {
  const order = ordered(barsOf(doc));
  const barId = order[order.indexOf(cursor.barId) + step];
  if (barId === undefined) return cursor;
  const ids = beatIds(voiceOf(doc, cursor, barId));
  const beatId = entry === "first" ? ids[0] : ids.at(-1);
  return beatId === undefined ? { ...cursor, barId, beatId: null, at: "after" } : { ...cursor, barId, beatId, at: "on" };
}

/**
 * The cursor at the first place of the bar after its own (`step` 1, Nav+→) or before it (-1):
 * the first beat of its voice there, or the append slot of an empty voice. At either end of the
 * score it stays.
 */
export function moveByBar(doc: Y.Doc, cursor: Cursor, step: 1 | -1): Cursor {
  return toNextBar(doc, cursor, step, "first");
}

/** → from the last beat of a voice: into its append slot when the bar is not full, else on to the next bar. */
function pastLastBeat(doc: Y.Doc, cursor: Cursor): Cursor {
  return isUnderfull(doc, cursor) ? { ...cursor, at: "after" } : toNextBar(doc, cursor, 1);
}

/**
 * The cursor one place later (`step` 1, →) or earlier (-1, ←). → goes to the next beat; from the
 * last beat into the append slot when the bar is not full, otherwise (and from the append slot)
 * to the first place of the next bar. ← goes from the append slot back to its anchor, else to the
 * beat before, else to the last beat of the bar before. At either end of the score it stays.
 */
export function moveByBeat(doc: Y.Doc, from: Cursor, step: 1 | -1): Cursor {
  const cursor = settleCursor(doc, from);
  if (cursor === null) return from;
  const ids = beatIds(voiceOf(doc, cursor));
  const index = cursor.beatId === null ? -1 : ids.indexOf(cursor.beatId);
  if (step === 1 && cursor.at === "on") {
    const next = ids[index + 1];
    return next === undefined ? pastLastBeat(doc, cursor) : { ...cursor, beatId: next };
  }
  if (step === -1) {
    if (cursor.at === "after" && cursor.beatId !== null) return { ...cursor, at: "on" };
    const before = ids[index - 1];
    if (cursor.at === "on" && before !== undefined) return { ...cursor, beatId: before };
  }
  return toNextBar(doc, cursor, step);
}

/**
 * → from the beat just made by typing in the append slot (docs/spec/commands.md, 5.1): that
 * beat is the new anchor, as if it were still the last of its voice, even when others have
 * appended after it meanwhile. So a member typing beat after beat keeps them together while
 * someone else types in the same bar. Its append slot when the bar is not full, else the first
 * place of the next bar.
 */
export function moveFromAppendedBeat(doc: Y.Doc, from: Cursor): Cursor {
  const cursor = settleCursor(doc, from);
  if (cursor === null) return from;
  // Settled off a beat only when its voice is now empty: then on to the next bar, as from any empty voice.
  return cursor.at === "on" ? pastLastBeat(doc, cursor) : toNextBar(doc, cursor, 1);
}

/** How many lines the cursor can stand on in a part: its strings when fretted, else the staff positions of a five-line staff with two ledger lines each side. */
function lineRange(kind: PartKind, strings: number): { first: number; last: number } {
  return kind === "fretted" ? { first: 1, last: Math.max(strings, 1) } : { first: -4, last: 12 };
}

/** The cursor one line lower on the page (`step` 1) or higher (-1), kept on the staff. */
export function moveByLine(doc: Y.Doc, cursor: Cursor, step: 1 | -1): Cursor {
  const part = partsOf(doc).get(cursor.partId);
  if (part === undefined) return cursor;
  const { first, last } = lineRange(part.get("kind") as PartKind, stringCountOf(part));
  return { ...cursor, line: Math.min(Math.max(cursor.line + step, first), last) };
}

/**
 * Where the beat of the cursor stands in its voice, as Yjs keeps it through everyone's changes.
 * Taken while the beat is there and handed to `settleCursor` later, it tells which beat took the
 * beat's place once it is removed. Null in the append slot, or when the beat is gone.
 */
export function beatPositionOf(doc: Y.Doc, cursor: Cursor): Y.RelativePosition | null {
  if (cursor.at !== "on" || cursor.beatId === null) return null;
  const voice = voiceOf(doc, cursor);
  const index = beatIds(voice).indexOf(cursor.beatId);
  return voice === undefined || index < 0 ? null : Y.createRelativePositionFromTypeIndex(voice, index);
}

/**
 * The cursor if its beat (or its anchor) still exists; otherwise the nearest place that does,
 * after an undo or another member's change (docs/spec/commands.md, section 2). A cursor whose
 * beat is gone lands on the beat that took its place, the next one, or the one before when it
 * was the last; that takes `position`, from `beatPositionOf` while the beat was there, and
 * without it the cursor lands on the last beat. An append slot whose anchor is gone moves after
 * the last beat; one others have appended after stays on its anchor. A voice left empty leaves
 * its append slot. Null when its part, bar or voice is gone.
 */
export function settleCursor(doc: Y.Doc, cursor: Cursor, position: Y.RelativePosition | null = null): Cursor | null {
  const voice = voiceOf(doc, cursor);
  if (voice === undefined || barsOf(doc).has(cursor.barId) === false) return null;
  if (cursor.at === "after" && cursor.beatId === null) return cursor;
  const ids = beatIds(voice);
  if (cursor.beatId !== null && ids.includes(cursor.beatId)) return cursor;
  if (ids.length === 0) return { ...cursor, beatId: null, at: "after" };
  // A removed beat's position resolves to the index it had among the beats still there.
  const where = cursor.at === "on" && position !== null ? Y.createAbsolutePositionFromRelativePosition(position, doc) : null;
  const index = where?.type === voice ? Math.min(where.index, ids.length - 1) : ids.length - 1;
  return { ...cursor, beatId: ids[index] as string };
}
