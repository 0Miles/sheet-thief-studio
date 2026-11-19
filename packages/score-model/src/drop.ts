// Dropping a fragment of bars on a part (docs/spec/commands.md, 5.7): a phrase put in place, or a
// fragment of bars pasted (5.6). It replaces, one command: from the bar dropped on, as many bars
// of the part as the fragment has, every voice of them. A fragment of beats pasted (5.6) is
// inserted instead, at the cursor.
import * as Y from "yjs";
import type { z } from "zod";

import { beatToY } from "./build";
import { type Cursor, insertBars, newId, placeFor } from "./commands";
import { writableCopy } from "./depth";
import { type BarsFragment, barsFragmentSchema, type BeatsFragment, beatsFragmentSchema, type BeatWithoutId } from "./phrases";
import {
  barsOf,
  contentMapOf,
  LOCAL,
  MAX_BARS,
  ordered,
  parsePlain,
  partKindOf,
  type PartKind,
  partSchemas,
  partsOf,
  readableVoicesOf,
  staffAndVoiceOf,
  staffCountOf,
  stringOfNoteKey,
  type YPart,
} from "./schema";

/** Where a fragment is dropped: a part, and the bar its first bar goes in. */
export interface DropTarget {
  partId: string;
  barId: string;
}

/**
 * Why a drop did nothing (docs/spec/commands.md, 5.7): the part or bar is gone (or the part cannot
 * be read); the part is of another kind; the fragment uses a string or a staff the part has not;
 * the score would have more than `MAX_BARS` bars; the fragment does not pass the schema.
 */
export type DropRefusal = "gone" | "otherKind" | "tooManyStrings" | "otherStaves" | "tooManyBars" | "invalid";

/** What the shell tells the member after a drop, no dialog: the tuning differs (frets went in as they are), bars were appended. */
export type DropHint = "tuningDiffers" | "barsAppended";

/** A drop done: the bars it wrote, in order (those appended last), and what to tell the member. */
export interface Dropped {
  barIds: string[];
  hints: DropHint[];
}

/** The highest string the beats have a note on; 0 when none. */
function highestString(beats: Iterable<BeatWithoutId>): number {
  let highest = 0;
  for (const beat of beats) for (const key of Object.keys(beat.notes)) highest = Math.max(highest, stringOfNoteKey(key) ?? 0);
  return highest;
}

/** Every beat of a fragment of bars, of every voice. */
function* beatsOfBars(fragment: BarsFragment): Generator<BeatWithoutId> {
  for (const bar of fragment.bars) for (const beats of Object.values(bar.voices)) yield* beats;
}

/** How many staves a fragment uses: up to the last staff with a beat (a rest too) in any voice of it. */
function stavesUsed(fragment: BarsFragment): number {
  let used = 0;
  for (const bar of fragment.bars) {
    for (const [voice, beats] of Object.entries(bar.voices)) if (beats.length > 0) used = Math.max(used, staffAndVoiceOf(voice)[0] + 1);
  }
  return used;
}

const tuningSchema = partSchemas.fretted.shape.tuning;

/**
 * Whether the strings a fretted fragment uses fit a part (docs/spec/commands.md, 5.7, points 6
 * and 7): false when it uses a string the part has not. When the tuning differs, or the part's
 * cannot be read (which says nothing of its strings, so any fits), `hints` is told so.
 */
function stringsFit(part: YPart, tuning: readonly number[], used: number, hints: DropHint[]): boolean {
  const read = parsePlain(tuningSchema, part.get("tuning"));
  if (read.success && used > read.data.length) return false;
  if (!read.success || JSON.stringify(read.data) !== JSON.stringify(tuning)) hints.push("tuningDiffers");
  return true;
}

/**
 * A fragment that passes its schema, as the copy that is written (`writableCopy`, #102: zod's
 * output nests two levels at most, so it always passes); none for one that does not.
 */
function validCopy<Schema extends z.ZodType>(schema: Schema, given: unknown): z.output<Schema> | undefined {
  const valid = schema.safeParse(given);
  return valid.success ? writableCopy(valid.data) : undefined;
}

/**
 * Why a fragment does not go on a part of `kind`, a drop and a paste alike: another kind, or a
 * string the part has not (`stringsFit`, which tells `hints` of a tuning that differs).
 */
function kindRefusal(part: YPart, kind: PartKind, fragment: BarsFragment | BeatsFragment, beats: Iterable<BeatWithoutId>, hints: DropHint[]): "otherKind" | "tooManyStrings" | undefined {
  if (kind !== fragment.kind) return "otherKind";
  if (fragment.kind === "fretted" && !stringsFit(part, fragment.tuning, highestString(beats), hints)) return "tooManyStrings";
  return undefined;
}

/**
 * Drop a fragment of bars on a part, from a bar on, one command (docs/spec/commands.md, 5.7). Every
 * voice the part reads in those bars is emptied and filled with the fragment's beats where it is,
 * not replaced, so that beats someone types there meanwhile are kept (and flagged overfull);
 * voices the fragment has nothing in stay empty. Every beat gets a new id. When the score has too
 * few bars, those missing are appended to every part (`insertBars`: the time signature of the bar
 * before) in the same transaction. Time signatures stay as the score has them. Refused, and
 * nothing changed, for a part of another kind, a string or a staff the fragment uses and the part
 * has not (a fretted part whose tuning cannot be read takes any string, telling the tuning
 * differs), or more than `MAX_BARS` bars; a fragment that does not pass `barsFragmentSchema` is
 * refused too, so that nothing the schema forbids gets into the document.
 */
export function dropFragment(doc: Y.Doc, target: DropTarget, given: BarsFragment): Dropped | DropRefusal {
  const fragment = validCopy(barsFragmentSchema, given);
  if (fragment === undefined) return "invalid";
  const part = partsOf(doc).get(target.partId);
  const kind = partKindOf(part);
  const order = ordered(barsOf(doc));
  const start = order.indexOf(target.barId);
  if (part === undefined || kind === undefined || contentMapOf(part) === undefined || start < 0) return "gone";
  const hints: DropHint[] = [];
  const refused = kindRefusal(part, kind, fragment, beatsOfBars(fragment), hints);
  if (refused !== undefined) return refused;
  if (stavesUsed(fragment) > staffCountOf(part)) return "otherStaves";
  const missing = Math.max(0, start + fragment.bars.length - order.length);
  if (order.length + missing > MAX_BARS) return "tooManyBars";
  if (missing > 0) hints.push("barsAppended");

  const barIds = order.slice(start, start + fragment.bars.length);
  doc.transact(() => {
    // insertBars joins this transaction: the bars appended go with the rest, one undo step.
    if (missing > 0) barIds.push(...insertBars(doc, { after: order.at(-1) as string, count: missing }));
    fragment.bars.forEach((bar, index) => {
      // The voices reading reads; one the document lacks is not made here (only the server fills, docs/spec/commands.md, section 9).
      for (const [key, voice] of readableVoicesOf(part, barIds[index] as string)) {
        const beats = bar.voices[key] ?? [];
        if (voice.length > 0) voice.delete(0, voice.length);
        if (beats.length > 0) voice.insert(0, beats.map((beat) => beatToY({ ...beat, id: newId() })));
      }
    });
  }, LOCAL);
  return { barIds, hints };
}

/** Why a paste of beats did nothing: the cursor's voice or beat is gone (or its part cannot be read), and as for a drop. */
export type BeatsPasteRefusal = "gone" | "otherKind" | "tooManyStrings" | "invalid";

/** Beats pasted: their new ids, in order, and what to tell the member. */
export interface PastedBeats {
  beatIds: string[];
  hints: DropHint[];
}

/**
 * Paste a fragment of beats at the cursor, one command (docs/spec/commands.md, 5.6): inserted in
 * its voice where `insertBeat` puts a beat (`placeFor`: before its beat, or in the append slot
 * after the anchor), each with a new id. Refused,
 * nothing changed, for a part of another kind, a fragment using a string the part has not (the
 * tuning differing is told, as for a drop), or one that does not pass `beatsFragmentSchema`.
 */
export function pasteBeats(doc: Y.Doc, cursor: Cursor, given: BeatsFragment): PastedBeats | BeatsPasteRefusal {
  const fragment = validCopy(beatsFragmentSchema, given);
  if (fragment === undefined) return "invalid";
  const part = partsOf(doc).get(cursor.partId);
  const kind = partKindOf(part);
  // Only a voice reading reads: a beat put anywhere else would not be seen.
  const readable = part !== undefined && readableVoicesOf(part, cursor.barId).some(([key]) => key === cursor.voice);
  const place = readable ? placeFor(doc, cursor) : undefined;
  if (part === undefined || kind === undefined || place === undefined) return "gone";
  const { voice, index } = place;
  const hints: DropHint[] = [];
  const refused = kindRefusal(part, kind, fragment, fragment.beats, hints);
  if (refused !== undefined) return refused;
  const beatIds = fragment.beats.map(() => newId());
  doc.transact(() => voice.insert(index, fragment.beats.map((beat, at) => beatToY({ ...beat, id: beatIds[at]! }))), LOCAL);
  return { beatIds, hints };
}
