// Restoring a version in place (docs/spec/collab.md, 8.5; docs/spec/commands.md, section 7):
// `replaceScore` writes the version over the score, ids kept, in one transaction of this member's.
import fc from "fast-check";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { addPart, barsOf, createScore, docToJson, insertBars, LOCAL, metaOf, ordered, partsOf, replaceScore, SCHEMA_VERSION, type ScoreJSON, setTitle } from "../src/index";
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
    fc.property(score({ maxBars: 2, maxParts: 2 }), (version) => {
      const { doc, undo } = typedScore();
      const before = docToJson(doc);
      replaceScore(doc, version);
      expect(docToJson(doc)).toEqual(version);
      undo.undo();
      expect(docToJson(doc)).toEqual(before);
      undo.redo();
      expect(docToJson(doc)).toEqual(version);
    }),
    { numRuns: 25 },
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

/** A version of `bars` bars and `parts` parts, every id starting with `tag`. */
function versionOf(tag: string, bars: number, parts: number): ScoreJSON {
  return {
    schemaVersion: SCHEMA_VERSION,
    title: tag,
    bars: Array.from({ length: bars }, (_, index) => ({ id: `${tag}-bar-${index}`, timeSig: { numerator: 4, denominator: 4 } })),
    parts: Array.from({ length: parts }, (_, index) => ({ id: `${tag}-part-${index}`, name: `${tag} ${index}`, kind: "pitched", tuning: [], capo: 0, program: 0, staves: [{ clef: "treble" }], content: {} })),
  };
}

/** The ids, in score order, that start with `tag`, and whether they stand in one stretch. */
function stretchOf(ids: string[], tag: string) {
  const at = ids.flatMap((id, index) => (id.startsWith(tag) ? [index] : []));
  return { ids: at.map((index) => ids[index]), together: at.every((index, i) => i === 0 || index === at[i - 1]! + 1) };
}

test("two members restoring at once, each before seeing the other's, keep each version's bars and parts in one stretch, in its order", () => {
  for (let run = 0; run < 50; run++) {
    const { doc: one } = typedScore();
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(one));
    const first = versionOf("one", 12, 3);
    const second = versionOf("two", 9, 2);
    replaceScore(one, first);
    replaceScore(other, second);
    Y.applyUpdate(one, Y.encodeStateAsUpdate(other, Y.encodeStateVector(one)));
    Y.applyUpdate(other, Y.encodeStateAsUpdate(one, Y.encodeStateVector(other)));

    for (const doc of [one, other]) {
      const bars = ordered(barsOf(doc));
      const parts = ordered(partsOf(doc));
      // What neither could take away, as they had not seen it: both versions, side by side.
      expect(bars).toHaveLength(21);
      expect(parts).toHaveLength(5);
      for (const [version, tag] of [
        [first, "one"],
        [second, "two"],
      ] as const) {
        expect(stretchOf(bars, tag)).toEqual({ ids: version.bars.map((bar) => bar.id), together: true });
        expect(stretchOf(parts, tag)).toEqual({ ids: version.parts.map((part) => part.id), together: true });
      }
    }
    expect(docToJson(one)).toEqual(docToJson(other));
  }
});

test("bars another member adds while one restores stay, beside the version's, and a bar inserted later goes where it is put", () => {
  const { doc: one } = typedScore();
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(one));
  const [added] = insertBars(other, { after: null, count: 1 });
  replaceScore(one, versionOf("v", 4, 1));
  Y.applyUpdate(one, Y.encodeStateAsUpdate(other, Y.encodeStateVector(one)));

  const bars = ordered(barsOf(one));
  expect(bars).toContain(added);
  expect(stretchOf(bars, "v")).toEqual({ ids: ["v-bar-0", "v-bar-1", "v-bar-2", "v-bar-3"], together: true });
  const [inserted] = insertBars(one, { after: "v-bar-1", count: 1 });
  expect(ordered(barsOf(one)).indexOf(inserted!)).toBe(ordered(barsOf(one)).indexOf("v-bar-1") + 1);
});
