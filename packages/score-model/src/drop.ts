// Dropping a fragment of bars on a part (docs/spec/commands.md, 5.7): a phrase put in place, or a
// fragment of bars pasted (5.6). It replaces, one command: from the bar dropped on, as many bars
// of the part as the fragment has, every voice of them.
import * as Y from "yjs";

import { beatToY } from "./build";
import { insertBars, newId } from "./commands";
import { writableCopy } from "./depth";
import { type BarsFragment, barsFragmentSchema } from "./phrases";
import {
  barsOf,
  contentMapOf,
  LOCAL,
  MAX_BARS,
  ordered,
  parsePlain,
  partKindOf,
  partSchemas,
  partsOf,
  readableVoicesOf,
  staffAndVoiceOf,
  staffCountOf,
  stringOfNoteKey,
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

/** The highest string a fretted fragment has a note on; 0 when none. */
function stringsUsed(fragment: BarsFragment): number {
  let highest = 0;
  for (const bar of fragment.bars) {
    for (const beats of Object.values(bar.voices)) {
      for (const beat of beats) for (const key of Object.keys(beat.notes)) highest = Math.max(highest, stringOfNoteKey(key) ?? 0);
    }
  }
  return highest;
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
  const valid = barsFragmentSchema.safeParse(given);
  // What is written is a copy as every member holds it, within MAX_VALUE_DEPTH (#102): zod's output nests two levels at most, so it always passes.
  const fragment = valid.success ? writableCopy(valid.data) : undefined;
  if (fragment === undefined) return "invalid";
  const part = partsOf(doc).get(target.partId);
  const kind = partKindOf(part);
  const order = ordered(barsOf(doc));
  const start = order.indexOf(target.barId);
  if (part === undefined || kind === undefined || contentMapOf(part) === undefined || start < 0) return "gone";
  if (kind !== fragment.kind) return "otherKind";
  const hints: DropHint[] = [];
  if (fragment.kind === "fretted") {
    // A tuning that cannot be read says nothing of the strings: the frets go in as they are, and the member is told the tuning differs.
    const tuning = parsePlain(tuningSchema, part.get("tuning"));
    if (tuning.success && stringsUsed(fragment) > tuning.data.length) return "tooManyStrings";
    if (!tuning.success || JSON.stringify(tuning.data) !== JSON.stringify(fragment.tuning)) hints.push("tuningDiffers");
  }
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
