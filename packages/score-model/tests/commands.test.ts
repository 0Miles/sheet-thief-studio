import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  addPart,
  barsOf,
  contentOf,
  createScore,
  type Cursor,
  cursorAt,
  deleteBeat,
  deleteNote,
  docToJson,
  fillMissingContent,
  flagsOf,
  insertBars,
  insertBeat,
  isRestAt,
  LOCAL,
  partsOf,
  SCHEMA_VERSION,
  setDuration,
  setFret,
  setNote,
  STANDARD_GUITAR,
} from "../src/index";
import { appendBeat } from "./support";

function score(bars = 2) {
  const doc = new Y.Doc();
  createScore(doc, "Demo");
  const barIds = insertBars(doc, { after: null, count: bars });
  const partId = addPart(doc, { name: "Guitar", kind: "fretted" });
  return { doc, barIds, partId };
}

test("a new score has its title, its bars in order and a place for them in every part", () => {
  const { doc, barIds, partId } = score(3);
  const json = docToJson(doc);
  expect(json.schemaVersion).toBe(SCHEMA_VERSION);
  expect(json.title).toBe("Demo");
  expect(json.bars.map((bar) => bar.id)).toEqual(barIds);
  expect(json.bars.every((bar) => bar.timeSig.numerator === 4 && bar.timeSig.denominator === 4)).toBe(true);
  expect(json.parts).toHaveLength(1);
  expect(json.parts[0]).toMatchObject({ id: partId, name: "Guitar", kind: "fretted", tuning: STANDARD_GUITAR });
  expect(Object.keys(json.parts[0]!.content).sort()).toEqual([...barIds].sort());
});

test("bars inserted in the middle land between their neighbours, for every part", () => {
  const { doc, barIds } = score(2);
  const bass = addPart(doc, { name: "Bass", kind: "fretted", tuning: [43, 38, 33, 28] });
  const [middle] = insertBars(doc, { after: barIds[0]!, count: 1, timeSig: { numerator: 3, denominator: 4 } });
  const [first] = insertBars(doc, { after: null, count: 1 });
  const json = docToJson(doc);
  expect(json.bars.map((bar) => bar.id)).toEqual([first, barIds[0], middle, barIds[1]]);
  expect(json.bars[2]!.timeSig).toEqual({ numerator: 3, denominator: 4 });
  for (const part of json.parts) expect(Object.keys(part.content)).toHaveLength(4);
  expect(json.parts.map((part) => part.id)).toContain(bass);
});

/** The beats of the first voice of a bar of the first part, as [id, value, dots, tuplet, notes]. */
function beatsOf(doc: Y.Doc, barId: string, part = 0) {
  return docToJson(doc).parts[part]!.content[barId]!["0:0"]!.map((beat) => [beat.id, beat.value, beat.dots, beat.tuplet, beat.notes]);
}

/** Count the transactions of a document from now on. */
function transactionsOf(doc: Y.Doc): { count: number } {
  const counter = { count: 0 };
  doc.on("afterTransaction", () => (counter.count += 1));
  return counter;
}

function undoOf(doc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager([barsOf(doc), partsOf(doc)], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
}

const triplet = { actual: 3, normal: 2 };

test("a beat is inserted before the beat of the cursor, as long as it, and the cursor moves onto it", () => {
  const { doc, barIds, partId } = score();
  const first = insertBeat(doc, cursorAt(doc, partId, barIds[0]!, 6), { value: 8, dots: 1, tuplet: triplet });
  const second = insertBeat(doc, first);
  expect(second).toEqual({ ...first, beatId: second.beatId, at: "on" });
  expect(beatsOf(doc, barIds[0]!)).toEqual([
    [second.beatId, 8, 1, triplet, {}],
    [first.beatId, 8, 1, triplet, {}],
  ]);
});

test("in the append slot a beat is appended after the anchor, as long as the anchor, or a quarter in an empty voice", () => {
  const { doc, barIds, partId } = score();
  const empty = cursorAt(doc, partId, barIds[0]!, 6);
  expect(empty).toMatchObject({ beatId: null, at: "after" });
  const first = insertBeat(doc, empty);
  setDuration(doc, first, { value: 16, dots: 2 });
  const second = appendBeat(doc, first);
  expect(second.at).toBe("on");
  expect(beatsOf(doc, barIds[0]!)).toEqual([
    [first.beatId, 16, 2, undefined, {}],
    [second.beatId, 16, 2, undefined, {}],
  ]);
  // An empty voice's append slot puts the beat first, whatever others have put there since.
  const third = insertBeat(doc, empty);
  expect(beatsOf(doc, barIds[0]!).map(([id, value]) => [id, value])).toEqual([
    [third.beatId, 4],
    [first.beatId, 16],
    [second.beatId, 16],
  ]);
});

test("a note typed in the append slot makes a beat with the note on it, in one undo step, and the cursor moves onto it", () => {
  const { doc, barIds, partId } = score();
  const undo = undoOf(doc);
  const transactions = transactionsOf(doc);
  const first = setFret(doc, cursorAt(doc, partId, barIds[0]!, 6), 5);
  expect(transactions.count).toBe(1);
  expect(first.at).toBe("on");
  expect(beatsOf(doc, barIds[0]!)).toEqual([[first.beatId, 4, 0, undefined, { s6: { fret: 5 } }]]);

  setDuration(doc, first, { value: 8, dots: 1 });
  const second = setFret(doc, { ...first, at: "after", line: 2 }, 7);
  expect(second).toEqual({ ...first, beatId: second.beatId, line: 2 });
  expect(beatsOf(doc, barIds[0]!)[1]).toEqual([second.beatId, 8, 1, undefined, { s2: { fret: 7 } }]);
  undo.undo();
  expect(beatsOf(doc, barIds[0]!).map(([id]) => id)).toEqual([first.beatId]);

  // Clearing a string in the append slot makes no beat.
  const before = transactions.count;
  expect(setFret(doc, { ...first, at: "after" }, null)).toEqual({ ...first, at: "after" });
  expect(transactions.count).toBe(before);
});

test("a drum piece typed in the append slot makes its beat as well", () => {
  const { doc, barIds } = score();
  const drums = addPart(doc, { name: "Drums", kind: "percussion" });
  const hit = setNote(doc, cursorAt(doc, drums, barIds[0]!), "p36", {});
  expect(beatsOf(doc, barIds[0]!, 1)).toEqual([[hit.beatId, 4, 0, undefined, { p36: {} }]]);
});

test("deleting a note takes the note off the cursor's string, in one undo step; a string without a note changes nothing", () => {
  const { doc, barIds, partId } = score();
  const undo = undoOf(doc);
  const cursor = setFret(doc, cursorAt(doc, partId, barIds[0]!, 6), 3);
  setFret(doc, { ...cursor, line: 5 }, 5);
  expect(isRestAt(doc, cursor)).toBe(false);
  expect(deleteNote(doc, cursor)).toEqual(cursor);
  expect(beatsOf(doc, barIds[0]!)[0]![4]).toEqual({ s5: { fret: 5 } });
  const transactions = transactionsOf(doc);
  deleteNote(doc, { ...cursor, line: 4 });
  expect(transactions.count).toBe(0);
  undo.undo();
  expect(beatsOf(doc, barIds[0]!)[0]![4]).toEqual({ s6: { fret: 3 }, s5: { fret: 5 } });
});

test("deleting a beat moves the cursor onto the beat that takes its place, or into the append slot after the new last beat", () => {
  const { doc, barIds, partId } = score();
  const undo = undoOf(doc);
  const a = insertBeat(doc, cursorAt(doc, partId, barIds[0]!, 6));
  const b = appendBeat(doc, a);
  const c = appendBeat(doc, b);
  expect(isRestAt(doc, b)).toBe(true);
  expect(deleteBeat(doc, b)).toEqual(c);
  expect(beatsOf(doc, barIds[0]!).map(([id]) => id)).toEqual([a.beatId, c.beatId]);
  undo.undo();
  expect(beatsOf(doc, barIds[0]!).map(([id]) => id)).toEqual([a.beatId, b.beatId, c.beatId]);

  expect(deleteBeat(doc, c)).toEqual({ ...b, at: "after" });
  deleteBeat(doc, b);
  expect(deleteBeat(doc, a)).toEqual({ ...a, beatId: null, at: "after" });
  expect(beatsOf(doc, barIds[0]!)).toEqual([]);
});

test("a fret goes on the string of the cursor; null clears it and other strings stay", () => {
  const { doc, barIds, partId } = score();
  const cursor = insertBeat(doc, cursorAt(doc, partId, barIds[0]!, 6), { value: 4 });
  setFret(doc, cursor, 3);
  setFret(doc, { ...cursor, line: 5 }, 5);
  const notes = () => docToJson(doc).parts[0]!.content[barIds[0]!]!["0:0"]![0]!.notes;
  expect(notes()).toEqual({ s6: { fret: 3 }, s5: { fret: 5 } });
  setFret(doc, cursor, null);
  expect(notes()).toEqual({ s5: { fret: 5 } });
});

test("a note goes on its beat under its key, whole: a drum piece, a spelled pitch", () => {
  const { doc, barIds } = score();
  const drums = addPart(doc, { name: "Drums", kind: "percussion" });
  const keys = addPart(doc, { name: "Keys", kind: "pitched", program: 0 });
  const hit = insertBeat(doc, cursorAt(doc, drums, barIds[0]!), { value: 8 });
  setNote(doc, hit, "p36", {});
  setNote(doc, hit, "p42", { ghost: true });
  const pitch = insertBeat(doc, cursorAt(doc, keys, barIds[0]!), { value: 4 });
  setNote(doc, pitch, "n61", { spell: "C#" });
  setNote(doc, pitch, "n61", { spell: "Db" });
  setNote(doc, pitch, "n64", {});
  setNote(doc, pitch, "n64", null);
  const beats = (index: number) => docToJson(doc).parts[index]!.content[barIds[0]!]!["0:0"]!;
  expect(beats(1)[0]!.notes).toEqual({ p36: {}, p42: { ghost: true } });
  expect(beats(2)[0]!.notes).toEqual({ n61: { spell: "Db" } });
});

test("a command on a beat that is gone changes nothing", () => {
  const { doc, barIds, partId } = score();
  const cursor: Cursor = { ...cursorAt(doc, partId, barIds[0]!), beatId: "gone", at: "on" };
  const transactions = transactionsOf(doc);
  expect(setFret(doc, cursor, 1)).toEqual(cursor);
  expect(setDuration(doc, cursor, { value: 8 })).toEqual(cursor);
  expect(insertBeat(doc, cursor)).toEqual(cursor);
  expect(deleteNote(doc, cursor)).toEqual(cursor);
  expect(deleteBeat(doc, cursor)).toEqual(cursor);
  expect(transactions.count).toBe(0);
});

test("an append slot whose anchor is gone appends after the last beat of its voice, as long as it", () => {
  const { doc, barIds, partId } = score();
  const first = insertBeat(doc, cursorAt(doc, partId, barIds[0]!), { value: 8 });
  const added = insertBeat(doc, { ...first, beatId: "gone", at: "after" });
  expect(beatsOf(doc, barIds[0]!).map(([id, value]) => [id, value])).toEqual([
    [first.beatId, 8],
    [added.beatId, 8],
  ]);
});

test("a voice that does not fill its bar is flagged; an empty or a full one is not", () => {
  const { doc, barIds, partId } = score(3);
  let cursor = insertBeat(doc, cursorAt(doc, partId, barIds[0]!), { value: 2 });
  expect(flagsOf(docToJson(doc))).toEqual([{ kind: "underfull", partId, barId: barIds[0], voice: "0:0" }]);
  cursor = appendBeat(doc, cursor, { value: 4 });
  cursor = appendBeat(doc, cursor, { value: 8 });
  cursor = appendBeat(doc, cursor, { value: 8 });
  expect(flagsOf(docToJson(doc))).toEqual([]);
  setDuration(doc, cursor, { value: 4, dots: 1 });
  expect(flagsOf(docToJson(doc))).toEqual([{ kind: "overfull", partId, barId: barIds[0], voice: "0:0" }]);
});

/** The voices the document holds for a bar of a part, whether or not they have beats. */
function voicesIn(doc: Y.Doc, partId: string, barId: string): string[] {
  return [...contentOf(partsOf(doc).get(partId)!).get(barId)!.keys()].sort();
}

test("new bars and new parts come with every voice of every staff, empty, and they read as one empty voice per staff", () => {
  const { doc, barIds, partId } = score(1);
  const drums = addPart(doc, { name: "Drums", kind: "percussion" });
  const keys = addPart(doc, { name: "Keys", kind: "pitched", staves: [{ clef: "treble" }, { clef: "bass" }] });
  const [added] = insertBars(doc, { after: barIds[0]!, count: 1 });
  for (const barId of [barIds[0]!, added!]) {
    expect(voicesIn(doc, partId, barId)).toEqual(["0:0", "0:1"]);
    expect(voicesIn(doc, drums, barId)).toEqual(["0:0", "0:1"]);
    expect(voicesIn(doc, keys, barId)).toEqual(["0:0", "0:1", "1:0", "1:1"]);
  }
  const json = docToJson(doc);
  expect(json.parts.map((part) => part.content[added!])).toEqual([{ "0:0": [] }, { "0:0": [] }, { "0:0": [], "1:0": [] }]);
  expect(json.parts.map((part) => [part.kind, part.staves, part.program])).toEqual([
    ["fretted", [{ clef: "tab" }], 25],
    ["percussion", [{ clef: "neutral" }], 0],
    ["pitched", [{ clef: "treble" }, { clef: "bass" }], 0],
  ]);
});

test("the server fills in the bars a part has no place for, and the voices a bar is missing", () => {
  const { doc, barIds, partId } = score(2);
  const keys = addPart(doc, { name: "Keys", kind: "pitched", staves: [{ clef: "treble" }, { clef: "bass" }] });
  contentOf(partsOf(doc).get(partId)!).delete(barIds[0]!);
  contentOf(partsOf(doc).get(keys)!).get(barIds[1]!)!.delete("1:1");
  const kept = contentOf(partsOf(doc).get(keys)!).get(barIds[1]!)!.get("0:0");
  fillMissingContent(doc);
  expect(voicesIn(doc, partId, barIds[0]!)).toEqual(["0:0", "0:1"]);
  expect(voicesIn(doc, keys, barIds[1]!)).toEqual(["0:0", "0:1", "1:0", "1:1"]);
  // What was there stays the same object: someone may be typing into it.
  expect(contentOf(partsOf(doc).get(keys)!).get(barIds[1]!)!.get("0:0")).toBe(kept);
});

test("filling in a score that misses nothing changes nothing, not even by an empty transaction", () => {
  const { doc } = score(2);
  let transactions = 0;
  doc.on("afterTransaction", () => transactions++);
  fillMissingContent(doc);
  expect(transactions).toBe(0);
});
