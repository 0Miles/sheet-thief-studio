// The clipboard (docs/spec/phrases.md, section 2; docs/spec/commands.md, 5.6): what a copy writes
// as `text/plain`, a prefix and a fragment's JSON, so that it goes across tabs, scores and into the
// phrase editor, and what a paste reads back. Bars pasted are dropped (`dropFragment`, through
// the editor's drop); beats pasted are inserted (`pasteBeats`).
import * as Y from "yjs";

import type { Selection } from "./commands";
import type { DropRefusal } from "./drop";
import { type BarsFragment, type Fragment, fragmentOfBars, fragmentOfBeats, fragmentSchema, MAX_FRAGMENT_BYTES, withoutId } from "./phrases";
import { docToJson } from "./read";
import { selectedBeats } from "./selection";

/** What the clipboard's text starts with: `@1` becomes `@2` once the fragments change in a way that is not only additions. */
export const CLIPBOARD_PREFIX = "sheet-thief-studio/fragment@1";

/** The prefix and the line feed after it, which a clipboard of Windows may have made CR LF. */
const HEAD = new RegExp(`^${CLIPBOARD_PREFIX.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\r?\\n`);

/** A fragment as the clipboard holds it: the prefix, a line feed, its JSON. */
export function clipboardText(fragment: Fragment): string {
  return `${CLIPBOARD_PREFIX}\n${JSON.stringify(fragment)}`;
}

/**
 * The fragment the clipboard's text holds; undefined for any text without the prefix (another
 * version's too), or whose JSON is not a fragment. JSON longer than `MAX_FRAGMENT_BYTES` UTF-16
 * units is not even parsed: in UTF-8 it is at least as many bytes, more than a fragment may be.
 */
export function fragmentOfClipboard(text: string): Fragment | undefined {
  const head = HEAD.exec(text);
  if (head === null || text.length - head[0].length > MAX_FRAGMENT_BYTES) return undefined;
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
  return beats.length === 0 ? undefined : fragmentOfBeats(part, beats);
}

/** Why a paste did nothing: the clipboard holds no fragment (`"nothing"`), or the fragment was refused (`DropRefusal`). */
export type PasteRefusal = "nothing" | DropRefusal;
