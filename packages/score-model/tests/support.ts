// What the tests of the score model share.
import type * as Y from "yjs";

import { type Cursor, type Duration, insertBeat } from "../src/index";

/** A rest right after the beat of the cursor, the cursor then on it: as Insert does in the append slot after that beat. */
export function appendBeat(doc: Y.Doc, after: Cursor, duration?: Duration): Cursor {
  return insertBeat(doc, { ...after, at: "after" }, duration);
}
