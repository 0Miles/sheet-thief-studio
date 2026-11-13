// Writing a score as plain data into a document and reading it back (docs/spec/schema.md 10, 12).
import fc from "fast-check";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { addPart, contentOf, createScore, docToJson, insertBars, jsonToDoc, type PartJSON, partsOf, SCHEMA_VERSION, type ScoreJSON } from "../src/index";
import { score } from "./arbitraries";

test("a score written into a document reads back the same", () => {
  fc.assert(
    fc.property(score(), (json) => {
      expect(docToJson(jsonToDoc(json))).toEqual(json);
    }),
    { numRuns: 300 },
  );
});

/**
 * The same score written as loosely as the schema allows: empty bars and empty voices left
 * out, empty second voices written.
 */
function loosened(json: ScoreJSON): fc.Arbitrary<ScoreJSON> {
  return fc.infiniteStream(fc.boolean()).map((choices) => {
    const choose = () => choices.next().value as boolean;
    const parts = json.parts.map((part): PartJSON => {
      const content: PartJSON["content"] = {};
      for (const [barId, voices] of Object.entries(part.content)) {
        if (Object.values(voices).every((beats) => beats.length === 0) && choose()) continue;
        const loose = { ...voices };
        part.staves.forEach((_, staff) => {
          if (loose[`${staff}:0`]?.length === 0 && choose()) delete loose[`${staff}:0`];
          if (loose[`${staff}:1`] === undefined && choose()) loose[`${staff}:1`] = [];
        });
        content[barId] = loose;
      }
      return { ...part, content } as PartJSON;
    });
    return { ...json, parts };
  });
}

test("a score written loosely reads back in the form docToJson gives, with the same music", () => {
  fc.assert(
    fc.property(
      score().chain((json) => fc.tuple(fc.constant(json), loosened(json))),
      ([json, loose]) => {
        expect(docToJson(jsonToDoc(loose))).toEqual(json);
      },
    ),
    { numRuns: 300 },
  );
});

test("the document keeps the ids of the score, its order, and a place for every voice of every bar", () => {
  const json: ScoreJSON = {
    schemaVersion: SCHEMA_VERSION,
    title: "Demo",
    bars: [
      { id: "b2", timeSig: { numerator: 4, denominator: 4 } },
      { id: "b1", timeSig: { numerator: 4, denominator: 4 } },
    ],
    parts: [
      { id: "keys", name: "Keys", kind: "pitched", tuning: [], capo: 0, program: 0, staves: [{ clef: "treble" }, { clef: "bass" }], content: {} },
      { id: "drums", name: "Drums", kind: "percussion", tuning: [], capo: 0, program: 0, staves: [{ clef: "neutral" }], content: { b1: { "0:1": [{ id: "k", value: 4, dots: 0, notes: { p36: {} } }] } } },
    ],
  };
  const doc = jsonToDoc(json);
  const read = docToJson(doc);
  expect(read.bars.map((bar) => bar.id)).toEqual(["b2", "b1"]);
  expect(read.parts.map((part) => part.id)).toEqual(["keys", "drums"]);
  expect(read.parts[1]!.content.b1).toEqual({ "0:0": [], "0:1": [{ id: "k", value: 4, dots: 0, notes: { p36: {} } }] });
  const voices = (partId: string, barId: string) => [...contentOf(partsOf(doc).get(partId)!).get(barId)!.keys()].sort();
  expect(voices("keys", "b1")).toEqual(["0:0", "0:1", "1:0", "1:1"]);
  expect(voices("drums", "b2")).toEqual(["0:0", "0:1"]);
});

test("a score written into a document that held one takes its place, title, bars and parts", () => {
  const doc = new Y.Doc();
  createScore(doc, "Old");
  insertBars(doc, { after: null, count: 3 });
  addPart(doc, { name: "Guitar", kind: "fretted" });
  const json: ScoreJSON = { schemaVersion: SCHEMA_VERSION, title: "New", artist: "Them", bars: [{ id: "b", timeSig: { numerator: 6, denominator: 8 } }], parts: [] };
  expect(jsonToDoc(json, doc)).toBe(doc);
  expect(docToJson(doc)).toEqual(json);
});

test("a score that is not legal, or not of the current schema, is not written", () => {
  const legal: ScoreJSON = { schemaVersion: SCHEMA_VERSION, title: "Demo", bars: [], parts: [] };
  expect(() => jsonToDoc({ ...legal, title: "a".repeat(101) })).toThrow();
  expect(() => jsonToDoc({ ...legal, schemaVersion: SCHEMA_VERSION - 1 })).toThrow(/migrate/);
  const doc = new Y.Doc();
  createScore(doc, "Kept");
  expect(() => jsonToDoc({ ...legal, bars: [{ id: "b", timeSig: { numerator: 0, denominator: 4 } }] }, doc)).toThrow();
  expect(docToJson(doc).title).toBe("Kept");
});
