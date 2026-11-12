import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  addPart,
  createScore,
  cursorAt,
  docToJson,
  flagsOf,
  insertBars,
  insertBeat,
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
