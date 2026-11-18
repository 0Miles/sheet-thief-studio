// What the phrase sidebar of the editable view decides without the DOM (docs/spec/phrases.md,
// section 6): which phrases fit the cursor's part, and where a phrase dragged over the score goes.
import { phraseDetails, type PhraseSummary } from "@studio/contracts";
import type { BarsFragment, Cursor, DropTarget, PartKind, ScoreJSON } from "@studio/score-model";

import { get } from "./api";

/** What a phrase's fit is told from: its kind, strings and staves as the library lists them. */
export type PhraseShape = Pick<PhraseSummary, "kind" | "stringCount" | "staffCount">;

/** What of a part a phrase is fitted to: its kind, its strings (by its tuning) and its staves. */
export interface FittedPart {
  kind: PartKind;
  tuning: readonly number[];
  staves: readonly unknown[];
}

/**
 * The phrase fits the part (docs/spec/phrases.md, section 6): the same kind; a fretted phrase on
 * no more strings than the part has; a pitched one on no more staves. A count the library does
 * not give (null) says nothing against it.
 */
export function fitsPart(phrase: PhraseShape, part: FittedPart): boolean {
  if (phrase.kind !== part.kind) return false;
  if (phrase.kind === "fretted") return (phrase.stringCount ?? 0) <= part.tuning.length;
  if (phrase.kind === "pitched") return (phrase.staffCount ?? 0) <= part.staves.length;
  return true;
}

/** The phrases the sidebar lists: those that fit the part, or all of them; all when there is no part to fit. */
export function phrasesShown<T extends PhraseShape>(phrases: readonly T[], part: FittedPart | undefined, all: boolean): T[] {
  return all || part === undefined ? [...phrases] : phrases.filter((phrase) => fitsPart(phrase, part));
}

/**
 * Where a phrase dragged over the score would go: the part and bar under the pointer (`hitTest`),
 * and the bars it would take from there, those the score has (more are appended on the drop). A
 * part of another kind takes none: it is drawn as "cannot drop" (`refused`), and a drop there does
 * nothing. Null outside any bar.
 */
export interface DropSpot extends DropTarget {
  refused: boolean;
  /** The last bar the phrase would replace, of those the score has: from `barId` to it. */
  last: string;
}

export function dropSpotOf(score: ScoreJSON, hit: Cursor | null, phrase: Pick<PhraseSummary, "kind" | "barCount">): DropSpot | null {
  if (hit === null) return null;
  const part = score.parts.find((each) => each.id === hit.partId);
  const index = score.bars.findIndex((bar) => bar.id === hit.barId);
  if (part === undefined || index < 0) return null;
  const refused = part.kind !== phrase.kind;
  const last = refused ? index : Math.min(index + Math.max(phrase.barCount, 1), score.bars.length) - 1;
  return { partId: part.id, barId: hit.barId, refused, last: score.bars[last]!.id };
}

/** The content of a phrase, asked for by its id. */
export type ReadPhrase = (id: string) => Promise<BarsFragment>;

const readFromServer: ReadPhrase = async (id) => (await get(`/api/phrases/${encodeURIComponent(id)}`, phraseDetails)).fragment;

/**
 * The contents of the phrases the sidebar previews and drops, each asked for once per revision:
 * a phrase changed since (a later revision in the list) is asked for again. One that could not be
 * had is asked for again the next time.
 */
export function phraseContents(read: ReadPhrase = readFromServer) {
  const held = new Map<string, Promise<BarsFragment>>();
  return {
    of(phrase: Pick<PhraseSummary, "id" | "revision">): Promise<BarsFragment> {
      const key = `${phrase.id}@${phrase.revision}`;
      let content = held.get(key);
      if (content === undefined) {
        content = read(phrase.id);
        held.set(key, content);
        content.catch(() => held.delete(key));
      }
      return content;
    },
  };
}
export type PhraseContents = ReturnType<typeof phraseContents>;
