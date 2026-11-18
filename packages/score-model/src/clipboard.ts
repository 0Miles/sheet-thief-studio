// The clipboard (docs/spec/phrases.md, section 2; docs/spec/commands.md, 5.6): what a copy writes
// as `text/plain`, a prefix and a fragment's JSON, so that it goes across tabs, scores and into the
// phrase editor; what a paste reads back, and does with it at the cursor.
import * as Y from "yjs";

import type { Cursor, Selection } from "./commands";
import { dropFragment, type DropHint, type DropRefusal, pasteBeats } from "./drop";
import { moveToBarStart } from "./navigation";
import { type BarsFragment, type Fragment, fragmentOfBars, fragmentSchema, withoutId } from "./phrases";
import { docToJson } from "./read";
import { selectedBeats } from "./selection";

/** What the clipboard's text starts with: `@1` becomes `@2` once the fragments change in a way that is not only additions. */
export const CLIPBOARD_PREFIX = "sheet-thief-studio/fragment@1";

/** A fragment as the clipboard holds it: the prefix, a line feed, its JSON. */
export function clipboardText(fragment: Fragment): string {
  return `${CLIPBOARD_PREFIX}\n${JSON.stringify(fragment)}`;
}

/**
 * The fragment the clipboard's text holds; undefined for any text without the prefix (another
 * version's too), or whose JSON is not a fragment. The line after the prefix may end with CR LF,
 * as a clipboard of Windows may have made it.
 */
export function fragmentOfClipboard(text: string): Fragment | undefined {
  const head = /^sheet-thief-studio\/fragment@1\r?\n/.exec(text);
  if (head === null) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text.slice(head[0].length));
  } catch {
    return undefined;
  }
  const parsed = fragmentSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** Told apart by its bars. */
export function isBarsFragment(fragment: Fragment): fragment is BarsFragment {
  return Array.isArray((fragment as { bars?: unknown }).bars);
}

/**
 * What a copy of the selection writes (docs/spec/commands.md, 5.6): a range of bars, a fragment of
 * bars; a range of beats, a fragment of its beats. Only what reading reads goes in, as the score
 * is drawn. Undefined when what it names is gone, or a range of beats holds none that reads.
 */
export function fragmentOfSelection(doc: Y.Doc, selection: Selection): Fragment | undefined {
  const score = docToJson(doc);
  if (selection.kind === "bars") return fragmentOfBars(score, selection);
  const part = score.parts.find((each) => each.id === selection.partId);
  const found = selectedBeats(doc, selection);
  if (part === undefined || found === undefined) return undefined;
  const ids = new Set(found.voice.slice(found.first, found.last + 1).map((beat) => (beat instanceof Y.Map ? beat.get("id") : undefined)));
  const beats = (part.content[selection.barId]?.[selection.voice] ?? []).filter((beat) => ids.has(beat.id)).map(withoutId);
  if (beats.length === 0) return undefined;
  if (part.kind === "fretted") return { kind: "fretted", tuning: [...part.tuning], beats } as Fragment;
  return { kind: part.kind, beats } as Fragment;
}

/** Why a paste did nothing: the clipboard holds no fragment (`"nothing"`), or the fragment was refused (`DropRefusal`). */
export type PasteRefusal = "nothing" | DropRefusal;

/** A paste done: where it leaves the cursor, and what to tell the member. */
export interface Pasted {
  cursor: Cursor;
  hints: DropHint[];
}

/**
 * Paste a fragment at the cursor, one command (docs/spec/commands.md, 5.6). Bars replace bars as a
 * drop does (5.7), from the cursor's bar in its part; the cursor then goes to the first place of
 * that bar in its voice. Beats are inserted in the cursor's voice (`pasteBeats`); the cursor then
 * goes on the last of them.
 */
export function pasteFragment(doc: Y.Doc, cursor: Cursor, fragment: Fragment): Pasted | DropRefusal {
  if (isBarsFragment(fragment)) {
    const dropped = dropFragment(doc, { partId: cursor.partId, barId: cursor.barId }, fragment);
    if (typeof dropped === "string") return dropped;
    // The cursor's beat went with what the bar held.
    return { cursor: moveToBarStart(doc, { ...cursor, beatId: null, at: "after" }), hints: dropped.hints };
  }
  const pasted = pasteBeats(doc, cursor, fragment);
  if (typeof pasted === "string") return pasted;
  return { cursor: { ...cursor, beatId: pasted.beatIds.at(-1)!, at: "on" }, hints: pasted.hints };
}
