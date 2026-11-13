// Moving the cursor through a score (docs/spec/commands.md, section 3). Nothing here changes the
// document: no move opens a transaction.
import type * as Y from "yjs";

import { type Cursor, durationOf } from "./commands";
import { barTicks, beatTicks } from "./flags";
import { barsOf, COMMON_TIME, contentOf, ordered, type PartKind, partsOf, timeSigSchema, type YVoice } from "./schema";

function voiceOf(doc: Y.Doc, cursor: Cursor, barId = cursor.barId): YVoice | undefined {
  const part = partsOf(doc).get(cursor.partId);
  return part && contentOf(part).get(barId)?.get(cursor.voice);
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
    const length = durationOf(beat);
    if (length !== undefined) held += beatTicks({ dots: 0, ...length });
  });
  return barTicks(timeSig.success ? timeSig.data : COMMON_TIME) - held >= 0.5;
}

/** The first place of a bar, for the cursor's voice: its first beat, or the append slot of an empty voice. */
function firstPlace(doc: Y.Doc, cursor: Cursor, barId: string): Cursor {
  const first = beatIds(voiceOf(doc, cursor, barId))[0];
  return first === undefined ? { ...cursor, barId, beatId: null, at: "after" } : { ...cursor, barId, beatId: first, at: "on" };
}

/** Where ← lands in a bar from the bar after it: its last beat, or the append slot of an empty voice. */
function lastBeat(doc: Y.Doc, cursor: Cursor, barId: string): Cursor {
  const last = beatIds(voiceOf(doc, cursor, barId)).at(-1);
  return last === undefined ? { ...cursor, barId, beatId: null, at: "after" } : { ...cursor, barId, beatId: last, at: "on" };
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
    if (next !== undefined) return { ...cursor, beatId: next };
    if (isUnderfull(doc, cursor)) return { ...cursor, at: "after" };
  }
  if (step === -1) {
    if (cursor.at === "after" && cursor.beatId !== null) return { ...cursor, at: "on" };
    const before = ids[index - 1];
    if (cursor.at === "on" && before !== undefined) return { ...cursor, beatId: before };
  }
  const order = ordered(barsOf(doc));
  const barId = order[order.indexOf(cursor.barId) + step];
  if (barId === undefined) return cursor;
  return step === 1 ? firstPlace(doc, cursor, barId) : lastBeat(doc, cursor, barId);
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
 * The cursor if its beat (or its anchor) still exists; otherwise the nearest place that does,
 * after an undo or another member's change. A cursor whose beat is gone moves onto the last beat
 * of its voice; an append slot whose anchor is gone, after it. Either way an empty voice leaves
 * its append slot. An append slot others have appended after stays on its anchor. Null when
 * its part, bar or voice is gone.
 */
export function settleCursor(doc: Y.Doc, cursor: Cursor): Cursor | null {
  const voice = voiceOf(doc, cursor);
  if (voice === undefined || barsOf(doc).has(cursor.barId) === false) return null;
  if (cursor.at === "after" && cursor.beatId === null) return cursor;
  const ids = beatIds(voice);
  if (cursor.beatId !== null && ids.includes(cursor.beatId)) return cursor;
  const last = ids.at(-1);
  if (last === undefined) return { ...cursor, beatId: null, at: "after" };
  return { ...cursor, beatId: last };
}
