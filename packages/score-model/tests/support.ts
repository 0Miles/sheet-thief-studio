// What the tests of the score model share.
import * as Y from "yjs";

import { barsOf, type Cursor, type Duration, insertBeat, LOCAL, partsOf } from "../src/index";

/** A rest right after the beat of the cursor, the cursor then on it: as Insert does in the append slot after that beat. */
export function appendBeat(doc: Y.Doc, after: Cursor, duration?: Duration): Cursor {
  return insertBeat(doc, { ...after, at: "after" }, duration);
}

/** Count the transactions of a document from now on. */
export function transactionsOf(doc: Y.Doc): { count: number } {
  const counter = { count: 0 };
  doc.on("afterTransaction", () => (counter.count += 1));
  return counter;
}

/** An undo manager of this member's commands, each its own step. */
export function undoOf(doc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager([barsOf(doc), partsOf(doc)], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
}
