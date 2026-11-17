// Moving the cursor through a score (docs/spec/commands.md, section 3). Nothing here changes the
// document: no move opens a transaction.
import * as Y from "yjs";

import type { Cursor } from "./commands";
import { barTicks, beatTicks, fillOf } from "./flags";
import {
  barsOf,
  COMMON_TIME,
  lineRange,
  durationOf,
  ordered,
  parsePlain,
  type PartKind,
  partKindOf,
  partsOf,
  staffAndVoiceOf,
  staffCountOf,
  startLine,
  stringCountOf,
  timeSigSchema,
  voiceIn,
  voiceKey,
  voicesOffered,
  type YBeat,
  type YVoice,
} from "./schema";

function voiceOf(doc: Y.Doc, cursor: Cursor, barId = cursor.barId): YVoice | undefined {
  return voiceIn(doc, { ...cursor, barId });
}

function beatIds(voice: YVoice | undefined): string[] {
  return voice ? voice.map((beat) => beat.get("id") as string) : [];
}

/** How many ticks a beat lasts; none when its length cannot be read, as reading leaves it out. */
function lengthOf(beat: YBeat): number {
  const duration = durationOf(beat);
  return duration === undefined ? 0 : beatTicks(duration);
}

/** Whether the beats of the cursor's voice add up to less than its bar: then its append slot can be reached by →. */
function isUnderfull(doc: Y.Doc, cursor: Cursor): boolean {
  const timeSig = parsePlain(timeSigSchema, barsOf(doc).get(cursor.barId)?.get("timeSig"));
  let held = 0;
  voiceOf(doc, cursor)?.forEach((beat) => {
    held += lengthOf(beat);
  });
  return fillOf(held, barTicks(timeSig.success ? timeSig.data : COMMON_TIME)) === "underfull";
}

/** The id `step` places after (1) or before (-1) `id` in `order`; none past either end, or when `id` is not there. */
function beside(order: readonly string[], id: string, step: 1 | -1): string | undefined {
  const index = order.indexOf(id);
  return index < 0 ? undefined : order[index + step];
}

/** The bar `step` bars after (1) or before (-1) `barId`; none past either end of the score. */
function barBeside(doc: Y.Doc, barId: string, step: 1 | -1): string | undefined {
  return beside(ordered(barsOf(doc)), barId, step);
}

/**
 * Where in its bar the cursor goes: its first place (Home), on its last beat, or the last place →
 * reaches there (End: the append slot when the bar is not full, else the last beat). Each is the
 * append slot of an empty voice.
 */
type BarPlace = "first" | "last" | "end";

/** The cursor at a place of its own bar. */
function placeIn(doc: Y.Doc, cursor: Cursor, place: BarPlace): Cursor {
  const ids = beatIds(voiceOf(doc, cursor));
  const beatId = place === "first" ? ids[0] : ids.at(-1);
  if (beatId === undefined) return { ...cursor, beatId: null, at: "after" };
  return { ...cursor, beatId, at: place === "end" && isUnderfull(doc, cursor) ? "after" : "on" };
}

/**
 * Where the cursor enters the bar after (`step` 1) or before (-1) its own: the first beat of its
 * voice there going forward, the last going back, unless `place` says otherwise; the append slot
 * of an empty voice. The cursor itself at either end of the score.
 */
function toNextBar(doc: Y.Doc, cursor: Cursor, step: 1 | -1, place: BarPlace = step === 1 ? "first" : "last"): Cursor {
  const barId = barBeside(doc, cursor.barId, step);
  return barId === undefined ? cursor : placeIn(doc, { ...cursor, barId }, place);
}

/**
 * The cursor at the first place of the bar after its own (`step` 1, Nav+→) or before it (-1):
 * the first beat of its voice there, or the append slot of an empty voice. At either end of the
 * score it stays, and so does a cursor whose part or bar is gone.
 */
export function moveByBar(doc: Y.Doc, from: Cursor, step: 1 | -1): Cursor {
  const cursor = settleCursor(doc, from);
  return cursor === null ? from : toNextBar(doc, cursor, step, "first");
}

/** The cursor at the first place of its bar (Home): its first beat, or the append slot of an empty voice. */
export function moveToBarStart(doc: Y.Doc, from: Cursor): Cursor {
  const cursor = settleCursor(doc, from);
  return cursor === null ? from : placeIn(doc, cursor, "first");
}

/**
 * The cursor at the last place of its bar that → reaches (End): the append slot when the bar is
 * not full, else its last beat; the append slot of an empty voice.
 */
export function moveToBarEnd(doc: Y.Doc, from: Cursor): Cursor {
  const cursor = settleCursor(doc, from);
  return cursor === null ? from : placeIn(doc, cursor, "end");
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

/** A line kept within those of a part (`lineRange`). */
function keptOn(kind: PartKind | undefined, strings: number, line: number): number {
  const { first, last } = lineRange(kind, strings);
  return Math.min(Math.max(line, first), last);
}

/** The cursor one line lower on the page (`step` 1) or higher (-1), kept on the staff. */
export function moveByLine(doc: Y.Doc, cursor: Cursor, step: 1 | -1): Cursor {
  const part = partsOf(doc).get(cursor.partId);
  if (part === undefined) return cursor;
  return { ...cursor, line: keptOn(partKindOf(part), stringCountOf(part), cursor.line + step) };
}

/** The tick of its bar the cursor stands at: where its beat starts, or in the append slot where its anchor ends. */
function tickAt(doc: Y.Doc, cursor: Cursor): number {
  let tick = 0;
  for (const beat of voiceOf(doc, cursor)?.toArray() ?? []) {
    const here = beat.get("id") === cursor.beatId;
    if (here && cursor.at === "on") return tick;
    tick += lengthOf(beat);
    if (here) return tick;
  }
  return 0;
}

/**
 * The cursor in another voice of the same bar (docs/spec/commands.md, section 3): on the beat of
 * that voice that holds `tick`, else where End goes there. Half a tick either way is the same
 * tick: tuplets of 5 or 7 do not add up evenly.
 */
function landAt(doc: Y.Doc, cursor: Cursor, tick: number): Cursor {
  let start = 0;
  for (const beat of voiceOf(doc, cursor)?.toArray() ?? []) {
    const end = start + lengthOf(beat);
    if (tick > start - 0.5 && tick < end - 0.5) return { ...cursor, beatId: beat.get("id") as string, at: "on" };
    start = end;
  }
  return placeIn(doc, cursor, "end");
}

/**
 * The cursor on the next staff of its part (`step` 1, Nav+↓) or the one before (-1, Nav+↑), in
 * the order of `staves`; past the last, on the first staff of the next part, past the first, on
 * the last staff of the part before. It stays in its bar and in the voice it is in, where the part
 * offers it (`voicesOffered`), and lands on the beat that holds the tick it stood at, else where
 * End goes. In another part it takes the line it had there last (`lines`, by part), else the
 * part's `startLine`, kept within its strings. It stays at either end of the score, and when its
 * part or bar is gone.
 */
export function moveByStaff(doc: Y.Doc, from: Cursor, step: 1 | -1, lines: ReadonlyMap<string, number> = new Map()): Cursor {
  const cursor = settleCursor(doc, from);
  if (cursor === null) return from;
  const parts = partsOf(doc);
  const [staff, voiceIndex] = staffAndVoiceOf(cursor.voice);
  const tick = tickAt(doc, cursor);
  if (staff + step >= 0 && staff + step < staffCountOf(parts.get(cursor.partId)!)) return landAt(doc, { ...cursor, voice: voiceKey(staff + step, voiceIndex) }, tick);
  // Parts whose kind cannot be read are not drawn: the cursor goes past them.
  const partId = beside(
    ordered(parts).filter((id) => partKindOf(parts.get(id)) !== undefined),
    cursor.partId,
    step,
  );
  if (partId === undefined) return cursor;
  const part = parts.get(partId)!;
  const kind = partKindOf(part)!;
  const voice = voiceKey(step === 1 ? 0 : staffCountOf(part) - 1, Math.min(voiceIndex, voicesOffered(kind) - 1));
  const line = keptOn(kind, stringCountOf(part), lines.get(partId) ?? startLine(kind));
  return landAt(doc, { ...cursor, partId, voice, line }, tick);
}

/** What `moveToVoice` gives for a voice the cursor's part does not offer. */
export const VOICE_NOT_OFFERED = "notOffered";
export type VoiceNotOffered = typeof VOICE_NOT_OFFERED;

/**
 * The cursor in the first (`voiceIndex` 0, Alt+1) or second voice (1, Alt+2) of its staff, in the
 * same bar, on the beat that holds the tick it stood at, else where End goes. It stays where it is
 * in that voice already. `VOICE_NOT_OFFERED` for a voice its part does not offer (`voicesOffered`:
 * a fretted part's second): the cursor stays, and the member is told why.
 */
export function moveToVoice(doc: Y.Doc, from: Cursor, voiceIndex: 0 | 1): Cursor | VoiceNotOffered {
  const cursor = settleCursor(doc, from);
  const kind = cursor && partKindOf(partsOf(doc).get(cursor.partId));
  if (!kind) return from;
  if (voiceIndex >= voicesOffered(kind)) return VOICE_NOT_OFFERED;
  const [staff, current] = staffAndVoiceOf(cursor.voice);
  if (voiceIndex === current) return cursor;
  return landAt(doc, { ...cursor, voice: voiceKey(staff, voiceIndex) }, tickAt(doc, cursor));
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
