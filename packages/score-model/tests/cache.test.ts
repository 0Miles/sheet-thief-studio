// Reading checks every beat against the schema; it checks a beat again only after something
// in its bar changed (docs/spec/schema.md section 11): a keystroke changes one bar.
// The tests on reads inside transactions and from observers also lock the two Yjs internals
// the reader relies on (`followTransactions` in src/read.ts): upgrading yjs must keep them green.
import { afterEach, expect, test, vi } from "vitest";
import * as Y from "yjs";

import { type BeatJSON, cursorAt, docToJson, insertBars, insertBeat, jsonToDoc, kindSchemas, partsOf, readScore, SCHEMA_VERSION, type ScoreJSON, setFret, setNote } from "../src/index";

const BARS = ["b1", "b2", "b3"];

/** A guitar and drums, four beats in every bar of both. */
function band(): Y.Doc {
  const beats = (prefix: string, notes: BeatJSON["notes"]) =>
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

test("a read inside a transaction, or from an observer that was there first, sees the change just made", () => {
  const doc = band();
  const fret = () => docToJson(doc).parts[0]!.content.b2!["0:0"]![1]!.notes.s6!.fret;
  const seen: (number | undefined)[] = [];
  // Registered before the first read, so before anything the reader listens to.
  partsOf(doc).observeDeep(() => seen.push(fret()));
  expect(fret()).toBe(3);
  doc.transact(() => {
    setFret(doc, { ...cursorAt(doc, "gtr", "b2", 6), beatId: "b2g1" }, 7);
    seen.push(fret());
    setFret(doc, { ...cursorAt(doc, "gtr", "b2", 6), beatId: "b2g1" }, 9);
    seen.push(fret());
  });
  expect(seen).toEqual([7, 9, 9]);
  expect(fret()).toBe(9);
});

test("a first read inside a transaction does not keep what it checked past a change later in it", () => {
  const doc = band();
  const fret = () => docToJson(doc).parts[0]!.content.b2!["0:0"]![1]!.notes.s6!.fret;
  doc.transact(() => {
    expect(fret()).toBe(3);
    setFret(doc, { ...cursorAt(doc, "gtr", "b2", 6), beatId: "b2g1" }, 7);
    expect(fret()).toBe(7);
  });
});

test("what is read inside a transaction about a bar it made is not kept: later reads see later changes", () => {
  const doc = band();
  let barId = "";
  doc.transact(() => {
    [barId] = insertBars(doc, { after: "b3", count: 1 });
    const cursor = insertBeat(doc, cursorAt(doc, "gtr", barId, 6), { value: 4 });
    setFret(doc, cursor, 3);
    expect(docToJson(doc).parts[0]!.content[barId]!["0:0"]![0]!.notes.s6!.fret).toBe(3);
    setFret(doc, cursor, 7);
  });
  expect(docToJson(doc).parts[0]!.content[barId]!["0:0"]![0]!.notes.s6!.fret).toBe(7);
});

test("an observer reading while transactions it opened are still to be ended sees their changes", () => {
  const doc = band();
  const fret = (bar: string, beat: number) => docToJson(doc).parts[0]!.content[bar]!["0:0"]![beat]!.notes.s6!.fret;
  const beatOf = (bar: string, beat: number) => ({ ...cursorAt(doc, "gtr", bar, 6), beatId: `${bar}g${beat}` });
  docToJson(doc); // every beat checked and kept
  const seen: (number | undefined)[] = [];
  let calls = 0;
  partsOf(doc).observeDeep(() => {
    calls++;
    if (calls === 1) {
      // Two transactions of their own, both ended only after this observer returns.
      setFret(doc, beatOf("b1", 0), 7);
      setFret(doc, beatOf("b3", 2), 9);
    } else if (calls === 2) {
      // Called for the first of them, while the second (bar 3) is still to be ended.
      seen.push(fret("b3", 2));
    }
  });
  setFret(doc, beatOf("b2", 1), 5);
  expect(seen).toEqual([9]);
  expect(fret("b3", 2)).toBe(9);
});
