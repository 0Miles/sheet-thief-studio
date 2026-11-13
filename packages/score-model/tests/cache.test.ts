// Reading checks every beat against the schema; it checks a beat again only after something
// in its bar changed (docs/spec/schema.md section 11): a keystroke changes one bar.
import { afterEach, expect, test, vi } from "vitest";
import * as Y from "yjs";

import { cursorAt, docToJson, jsonToDoc, kindSchemas, readScore, SCHEMA_VERSION, type ScoreJSON, setFret, setNote } from "../src/index";

const BARS = ["b1", "b2", "b3"];

/** A guitar and drums, four beats in every bar of both. */
function band(): Y.Doc {
  const beats = (prefix: string, notes: ScoreJSON["parts"][number]["content"][string][string][number]["notes"]) =>
    Array.from({ length: 4 }, (_, index) => ({ id: `${prefix}${index}`, value: 4 as const, dots: 0 as const, notes }));
  const json: ScoreJSON = {
    schemaVersion: SCHEMA_VERSION,
    title: "Demo",
    bars: BARS.map((id) => ({ id, timeSig: { numerator: 4, denominator: 4 } })),
    parts: [
      { id: "gtr", name: "Guitar", kind: "fretted", tuning: [64, 59, 55, 50, 45, 40], capo: 0, program: 25, staves: [{ clef: "tab" }], content: Object.fromEntries(BARS.map((bar) => [bar, { "0:0": beats(`${bar}g`, { s6: { fret: 3 } }) }])) },
      { id: "drm", name: "Drums", kind: "percussion", tuning: [], capo: 0, program: 0, staves: [{ clef: "neutral" }], content: Object.fromEntries(BARS.map((bar) => [bar, { "0:0": beats(`${bar}d`, { p36: {} }) }])) },
    ],
  };
  return jsonToDoc(json);
}

/** Count the beats checked from now on, by kind of part. */
function countChecks() {
  return { guitar: vi.spyOn(kindSchemas.fretted.beat, "safeParse"), drums: vi.spyOn(kindSchemas.percussion.beat, "safeParse") };
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("reading again a score that did not change checks no beat", () => {
  const doc = band();
  docToJson(doc);
  const checks = countChecks();
  docToJson(doc);
  expect(checks.guitar).not.toHaveBeenCalled();
  expect(checks.drums).not.toHaveBeenCalled();
});

test("after a change in one bar, only the beats of that bar are checked again, and the change is read", () => {
  const doc = band();
  docToJson(doc);
  const checks = countChecks();
  setFret(doc, { ...cursorAt(doc, "gtr", "b2", 6), beatId: "b2g1" }, 7);
  const json = docToJson(doc);
  expect(checks.guitar).toHaveBeenCalledTimes(4);
  expect(checks.drums).not.toHaveBeenCalled();
  expect(json.parts[0]!.content.b2!["0:0"]!.map((beat) => beat.notes.s6!.fret)).toEqual([3, 7, 3, 3]);
});

test("a change another member made in one bar is also read, and only that bar checked again", () => {
  const doc = band();
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  docToJson(doc);
  const checks = countChecks();
  setNote(other, { ...cursorAt(other, "drm", "b3"), beatId: "b3d2" }, "p36", null);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)));
  const json = docToJson(doc);
  expect(checks.drums).toHaveBeenCalledTimes(4);
  expect(checks.guitar).not.toHaveBeenCalled();
  expect(json.parts[1]!.content.b3!["0:0"]![2]!.notes).toEqual({});
  expect(json).toEqual(docToJson(other));
});

test("a part whose tuning changes has its beats checked again: notes on strings it no longer has are left out", () => {
  const doc = band();
  docToJson(doc);
  (doc.getMap("parts").get("gtr") as Y.Map<unknown>).set("tuning", [43, 38, 33, 28, 23]);
  const { score: json, invalid } = readScore(doc);
  expect(BARS.map((bar) => json.parts[0]!.content[bar]!["0:0"]!.map((beat) => beat.notes))).toEqual(BARS.map(() => [{}, {}, {}, {}]));
  expect(invalid).toHaveLength(12);
});
