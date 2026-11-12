// What a transaction changed, coarsely: enough to decide how much of the score to draw again.
import type * as Y from "yjs";

import { barsOf, metaOf, partsOf } from "./schema";

/**
 * The bars whose content changed (in any part), or "structure" when something else did: the
 * bars themselves, the parts, the title, or which bars a part has content for.
 */
export type ScoreChange = { kind: "content"; barIds: Set<string> } | { kind: "structure" };

/**
 * Call `listener` after every transaction that changed the score, whoever made it. Returns the
 * function that stops it.
 */
export function observeScore(doc: Y.Doc, listener: (change: ScoreChange, transaction: Y.Transaction) => void): () => void {
  let structure = false;
  let barIds = new Set<string>();
  const onStructure = (): void => {
    structure = true;
  };
  const onParts = (events: Y.YEvent<Y.Map<unknown>>[]): void => {
    for (const event of events) {
      // Inside a part: ["<part>", "content", "<bar>", "<voice>", index, …]. A change at
      // ["<part>", "content"] adds or removes the content of a bar: not a change inside one.
      const [, field, barId] = event.path;
      if (field === "content" && typeof barId === "string") barIds.add(barId);
      else structure = true;
    }
  };
  const afterTransaction = (transaction: Y.Transaction): void => {
    if (!structure && barIds.size === 0) return;
    const change: ScoreChange = structure ? { kind: "structure" } : { kind: "content", barIds };
    structure = false;
    barIds = new Set();
    listener(change, transaction);
  };
  const bars = barsOf(doc);
  const parts = partsOf(doc);
  const meta = metaOf(doc);
  bars.observeDeep(onStructure);
  meta.observeDeep(onStructure);
  parts.observeDeep(onParts);
  doc.on("afterTransaction", afterTransaction);
  return () => {
    bars.unobserveDeep(onStructure);
    meta.unobserveDeep(onStructure);
    parts.unobserveDeep(onParts);
    doc.off("afterTransaction", afterTransaction);
  };
}
