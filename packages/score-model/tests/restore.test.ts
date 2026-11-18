// Restoring a version in place (docs/spec/collab.md, 8.5; docs/spec/commands.md, section 7):
// `replaceScore` writes the version over the score, ids kept, in one transaction of this member's.
import fc from "fast-check";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { addPart, barsOf, createScore, docToJson, insertBars, LOCAL, metaOf, partsOf, replaceScore, SCHEMA_VERSION, type ScoreJSON, setTitle } from "../src/index";
import { score } from "./arbitraries";
import { SCORE_V0, zeroToOne } from "./fixtures/scoreV0";

/** A score someone has been typing in, and an undo manager of this member's changes, as the editor keeps one. */
function typedScore() {
  const doc = new Y.Doc();
  createScore(doc, "Now");
  insertBars(doc, { after: null, count: 3 });
  addPart(doc, { name: "Guitar", kind: "fretted" });
  const undo = new Y.UndoManager([barsOf(doc), partsOf(doc), metaOf(doc)], { trackedOrigins: new Set([LOCAL]), captureTimeout: Infinity });
  undo.stopCapturing();
  return { doc, undo };
}

test("after a restore the score reads as the version, ids and all; one undo brings back the score as it was before", () => {
  fc.assert(
    fc.property(score(), (version) => {
      const { doc, undo } = typedScore();
      const before = docToJson(doc);
      replaceScore(doc, version);
      expect(docToJson(doc)).toEqual(version);
      undo.undo();
      expect(docToJson(doc)).toEqual(before);
      undo.redo();
      expect(docToJson(doc)).toEqual(version);
    }),
    { numRuns: 100 },
  );
});

test("a restore is one transaction of this member's: the others get it as one update", () => {
  const { doc } = typedScore();
  const origins: unknown[] = [];
  doc.on("afterTransaction", (transaction: Y.Transaction) => origins.push(transaction.origin));
  const version: ScoreJSON = { schemaVersion: SCHEMA_VERSION, title: "Then", bars: [{ id: "b", timeSig: { numerator: 3, denominator: 4 } }], parts: [] };
  replaceScore(doc, version);
  expect(origins).toEqual([LOCAL]);
  expect(docToJson(doc)).toEqual(version);
});

test("a version of an older schema is migrated first; one that cannot be read changes nothing", () => {
  const { doc } = typedScore();
  replaceScore(doc, SCORE_V0, [zeroToOne]);
  expect(docToJson(doc).title).toBe(SCORE_V0.title);
  expect(docToJson(doc).schemaVersion).toBe(SCHEMA_VERSION);

  setTitle(doc, "Kept");
  const kept = docToJson(doc);
  expect(() => replaceScore(doc, SCORE_V0, [])).toThrow();
  expect(() => replaceScore(doc, { ...kept, schemaVersion: SCHEMA_VERSION + 1 })).toThrow();
  expect(() => replaceScore(doc, { ...kept, bars: [{ id: "b", timeSig: { numerator: 0, denominator: 4 } }] })).toThrow();
  expect(docToJson(doc)).toEqual(kept);
});
