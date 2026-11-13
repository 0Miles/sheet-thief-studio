import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  addPart,
  contentOf,
  createScore,
  cursorAt,
  docToJson,
  fillMissingContent,
  flagsOf,
  insertBars,
  insertBeat,
  partsOf,
  SCHEMA_VERSION,
  setDuration,
  setFret,
  setNote,
  STANDARD_GUITAR,
} from "../src/index";

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

test("beats are inserted after the cursor and the cursor follows them", () => {
  const { doc, barIds, partId } = score();
  let cursor = cursorAt(doc, partId, barIds[0]!, 6);
  expect(cursor.beatId).toBeNull();
  cursor = insertBeat(doc, cursor, { value: 4 });
  const first = cursor.beatId;
  cursor = insertBeat(doc, cursor, { value: 8 });
  const second = cursor.beatId;
  cursor = insertBeat(doc, { ...cursor, beatId: first }, { value: 16, dots: 1 });
  const beats = docToJson(doc).parts[0]!.content[barIds[0]!]!["0:0"]!;
  expect(beats.map((beat) => [beat.id, beat.value, beat.dots])).toEqual([
    [first, 4, 0],
    [cursor.beatId, 16, 1],
    [second, 8, 0],
  ]);
  expect(cursorAt(doc, partId, barIds[0]!).beatId).toBe(first);
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
  const cursor = { ...cursorAt(doc, partId, barIds[0]!), beatId: "gone" };
  const before = docToJson(doc);
  expect(setFret(doc, cursor, 1)).toEqual(cursor);
  expect(setDuration(doc, cursor, { value: 8 })).toEqual(cursor);
  expect(docToJson(doc)).toEqual(before);
});

test("a voice that does not fill its bar is flagged; an empty or a full one is not", () => {
  const { doc, barIds, partId } = score(3);
  let cursor = insertBeat(doc, cursorAt(doc, partId, barIds[0]!), { value: 2 });
  expect(flagsOf(docToJson(doc))).toEqual([{ kind: "underfull", partId, barId: barIds[0], voice: "0:0" }]);
  cursor = insertBeat(doc, cursor, { value: 4 });
  cursor = insertBeat(doc, cursor, { value: 8 });
  cursor = insertBeat(doc, cursor, { value: 8 });
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
