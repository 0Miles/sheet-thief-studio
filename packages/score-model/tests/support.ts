// What the tests of the score model share.
import { expect } from "vitest";
import * as Y from "yjs";

import { barsOf, type Cursor, type Duration, insertBeat, LOCAL, type NoteJSON, partsOf } from "../src/index";

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

/**
 * Undo every step of a technique stepped through, last first: the note goes back through each of
 * `states` (what it held besides `base`, the first before any step) to the first. Then there is
 * nothing more to undo.
 */
export function undoEach(undo: Y.UndoManager, note: () => NoteJSON, states: Partial<NoteJSON>[], base: NoteJSON): void {
  for (const state of [...states].reverse()) {
    undo.undo();
    expect(note()).toEqual({ ...base, ...state });
  }
  expect(undo.canUndo()).toBe(false);
}
