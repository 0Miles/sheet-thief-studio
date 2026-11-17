// Bringing documents and versions of an older schema up to date, on both sides with the same
// meaning (docs/spec/schema.md sections 9 and 10).
import { expect, test } from "vitest";
import * as Y from "yjs";

import { createScore, docToJson, isNewerSchema, metaOf, type Migration, migrateDoc, migrateJson, partsOf, SCHEMA_VERSION, scoreSchema } from "../src/index";
import { docV0, SCORE_V0 } from "./fixtures/scoreV0";

const STAVES: Record<string, { clef: string }[]> = { fretted: [{ clef: "tab" }], percussion: [{ clef: "neutral" }], pitched: [{ clef: "treble" }] };

/** Schema 0 to 1, registered here only: every part gets the staves of its kind. */
const zeroToOne: Migration = {
  from: 0,
  to: 1,
  doc(doc) {
    for (const part of partsOf(doc).values()) part.set("staves", STAVES[part.get("kind") as string]);
  },
  json(json) {
    const score = json as typeof SCORE_V0;
    return { ...score, parts: score.parts.map((part) => ({ ...part, staves: STAVES[part.kind] })) };
  },
};

test("an old document and an old version are both brought to the current schema, and read the same", () => {
  const doc = docV0();
  let transactions = 0;
  doc.on("afterTransaction", () => transactions++);
  expect(migrateDoc(doc, [zeroToOne])).toBe(true);
  expect(transactions).toBe(1);
  expect(metaOf(doc).get("schemaVersion")).toBe(SCHEMA_VERSION);

  const fromDoc = docToJson(doc);
  const fromJson = migrateJson(SCORE_V0, [zeroToOne]);
  expect(fromJson.schemaVersion).toBe(SCHEMA_VERSION);
  expect(scoreSchema.safeParse(fromDoc).success).toBe(true);
  expect(scoreSchema.safeParse(fromJson).success).toBe(true);
  expect(fromDoc).toEqual(fromJson);
  expect(fromDoc.parts.map((part) => part.staves)).toEqual([[{ clef: "tab" }], [{ clef: "treble" }]]);
});

test("a document or a version of the current schema is left as it is", () => {
  const doc = new Y.Doc();
  createScore(doc, "Now");
  let transactions = 0;
  doc.on("afterTransaction", () => transactions++);
  expect(migrateDoc(doc, [zeroToOne])).toBe(false);
  expect(migrateDoc(new Y.Doc())).toBe(false);
  expect(transactions).toBe(0);
  const json = docToJson(doc);
  expect(migrateJson(json)).toEqual(json);
});

test("a step missing from the migrations stops the migration and changes nothing", () => {
  const doc = docV0();
  const before = docToJson(doc);
  expect(() => migrateDoc(doc, [])).toThrow(/schema version 0/);
  expect(docToJson(doc)).toEqual(before);
  expect(() => migrateJson(SCORE_V0, [])).toThrow(/schema version 0/);
});

test("a document of a newer schema than this code is told apart, and neither side migrates it", () => {
  const doc = new Y.Doc();
  createScore(doc, "Later");
  expect(isNewerSchema(doc)).toBe(false);
  expect(isNewerSchema(docV0())).toBe(false);
  expect(isNewerSchema(new Y.Doc())).toBe(false);
  metaOf(doc).set("schemaVersion", SCHEMA_VERSION + 1);
  expect(isNewerSchema(doc)).toBe(true);
  expect(migrateDoc(doc, [zeroToOne])).toBe(false);
  expect(metaOf(doc).get("schemaVersion")).toBe(SCHEMA_VERSION + 1);
  expect(() => migrateJson({ ...docToJson(doc), schemaVersion: SCHEMA_VERSION + 1 })).toThrow(/newer/);
});

test("a schema version that cannot be read is taken as the current one, as reading takes it: nothing to migrate, nothing locked", () => {
  for (const version of [-1, 0.5, "1", null]) {
    const doc = new Y.Doc();
    createScore(doc, "Odd");
    metaOf(doc).set("schemaVersion", version);
    expect(migrateDoc(doc, [zeroToOne])).toBe(false);
    expect(isNewerSchema(doc)).toBe(false);
    expect(migrateJson({ schemaVersion: version, title: "Odd", bars: [], parts: [] }).schemaVersion).toBe(SCHEMA_VERSION);
  }
  expect(migrateJson({ title: "No version", bars: [], parts: [] }).schemaVersion).toBe(SCHEMA_VERSION);
});

test("a version that does not pass the schema once migrated is refused", () => {
  expect(() => migrateJson({ ...SCORE_V0, title: 7 }, [zeroToOne])).toThrow();
  expect(() => migrateJson("not a score")).toThrow();
});
