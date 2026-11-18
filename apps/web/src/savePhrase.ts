// Bars of a score saved as a phrase (docs/spec/phrases.md, section 3): what a range of bars
// selected in either edit view gives the library, the name it is offered under, and saving it.
import { createdPhrase, phraseLimits } from "@studio/contracts";
import { type BarsFragment, type Flag, fragmentOfBars, type ScoreJSON, type Selection } from "@studio/score-model";

import { ApiError, postFor, refusal } from "./api";
import { errorText, strings } from "./strings";

/**
 * What saving the bars selected would save: their fragment, the numbers of the first and last of
 * them in the score (from 1), and whether anything of them could not be read, and so is not in it.
 */
export interface BarsToSave {
  fragment: BarsFragment;
  first: number;
  last: number;
  skipped: boolean;
}

/**
 * The bars a selection names, as a phrase saves them; null unless it is a range of bars still in
 * the score. `flags` are the score's: content of that part in those bars, or of those bars, that
 * could not be read is left out of the fragment, as it is of the score read.
 */
export function barsToSave(score: ScoreJSON, selection: Selection | null, flags: readonly Flag[]): BarsToSave | null {
  if (selection?.kind !== "bars") return null;
  const fragment = fragmentOfBars(score, selection);
  if (fragment === undefined) return null;
  const numbers = [selection.anchorBarId, selection.focusBarId].map((barId) => score.bars.findIndex((bar) => bar.id === barId) + 1);
  const first = Math.min(...numbers);
  const last = Math.max(...numbers);
  const barIds = new Set(score.bars.slice(first - 1, last).map((bar) => bar.id));
  const skipped = flags.some(
    (flag) => flag.kind === "invalidContent" && flag.barId !== undefined && barIds.has(flag.barId) && (flag.partId === undefined || flag.partId === selection.partId),
  );
  return { fragment, first, last, skipped };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The name a phrase saved from these bars is offered under: 「<title> 第 a–b 小節」, an untitled
 * score's as 「未命名」. A title too long for a phrase's name (100 UTF-16 code units, as the server
 * counts) is cut short a whole character at a time, an emoji of several code points never split,
 * so that the bars always fit.
 */
export function defaultPhraseName(title: string, first: number, last: number): string {
  const shown = title.trim() === "" ? strings.score.untitled : title.trim();
  const room = phraseLimits.name.max - strings.savePhrase.defaultName("", first, last).length;
  let cut = "";
  for (const { segment } of graphemes.segment(shown)) {
    if (cut.length + segment.length > room) break;
    cut += segment;
  }
  return strings.savePhrase.defaultName(cut.trimEnd(), first, last);
}

/** Save bars as a new phrase of the member's own (`POST /api/phrases`): its id. Refusals throw (ApiError). */
export async function saveAsPhrase(name: string, fragment: BarsFragment): Promise<string> {
  return (await postFor("/api/phrases", { name, fragment }, createdPhrase)).id;
}

/**
 * What to tell the member about a save refused. Every 413 is a phrase too large: the server's
 * check of a fragment's size, and its own limit of a request's size (`payload_too_large`) alike,
 * as the phrase editor says (phraseSaver.ts).
 */
export function saveRefusal(failure: unknown): string {
  return failure instanceof ApiError && failure.status === 413 ? errorText("phrase_too_large") : refusal(failure);
}
