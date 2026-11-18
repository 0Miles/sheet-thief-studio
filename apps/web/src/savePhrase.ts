// Bars of a score saved as a phrase (docs/spec/phrases.md, section 3): what a range of bars
// selected in either edit view gives the library, and the name it is offered under.
import { phraseLimits } from "@studio/contracts";
import { type BarsFragment, fragmentOfBars, type ScoreJSON, type Selection } from "@studio/score-model";

import { strings } from "./strings";

/** What saving the bars selected would save: their fragment, and the numbers of the first and last of them in the score (from 1). */
export interface BarsToSave {
  fragment: BarsFragment;
  first: number;
  last: number;
}

/** The bars a selection names, as a phrase saves them; null unless it is a range of bars still in the score. */
export function barsToSave(score: ScoreJSON, selection: Selection | null): BarsToSave | null {
  if (selection?.kind !== "bars") return null;
  const fragment = fragmentOfBars(score, selection);
  if (fragment === undefined) return null;
  const numbers = [selection.anchorBarId, selection.focusBarId].map((barId) => score.bars.findIndex((bar) => bar.id === barId) + 1);
  return { fragment, first: Math.min(...numbers), last: Math.max(...numbers) };
}

/**
 * The name a phrase saved from these bars is offered under: 「<title> 第 a–b 小節」, an untitled
 * score's as 「未命名」. A title too long for a phrase's name is cut short, a whole character at a
 * time, so that the bars always fit.
 */
export function defaultPhraseName(title: string, first: number, last: number): string {
  const shown = title.trim() === "" ? strings.score.untitled : title.trim();
  const room = phraseLimits.name.max - strings.savePhrase.defaultName("", first, last).length;
  let cut = "";
  for (const character of shown) {
    if (cut.length + character.length > room) break;
    cut += character;
  }
  return strings.savePhrase.defaultName(cut.trimEnd(), first, last);
}
