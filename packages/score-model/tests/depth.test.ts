// How deep the JSON values of the document may nest (#102). lib0's readAny decodes a value one
// call per level: a value some thousands deep is one its writer holds and the others cannot
// decode. No value deeper than MAX_VALUE_DEPTH is read, written by a command, or let through.
import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  addPart,
  barsOf,
  type BeatChange,
  changeBeatAt,
  contentOf,
  type Cursor,
  dropTooDeep,
  durationOf,
  insertBars,
  insertBeat,
  jsonToDoc,
  MAX_VALUE_DEPTH,
  metaOf,
  type NoteJSON,
  type NoteToggle,
  ownFields,
  parsePlain,
  partsOf,
  readScore,
  SCHEMA_VERSION,
  type ScoreJSON,
  setFret,
  setNote,
  timeSigSchema,
  toggleAt,
  toggleOnSelection,
  updateWithinDepth,
  type YBeat,
} from "../src/index";
import { deepUpdate, nested } from "./fixtures/deep";
import { transactionsOf } from "./support";

/** One bar of 4/4 and a guitar with two quarter notes in it. */
function band(): ScoreJSON {
  return {
    schemaVersion: SCHEMA_VERSION,
    title: "Demo",
    bars: [{ id: "b1", timeSig: { numerator: 4, denominator: 4 } }],
    parts: [
      {
        id: "gtr",
        name: "Guitar",
        kind: "fretted",
        tuning: [64, 59, 55, 50, 45, 40],
        capo: 0,
        program: 25,
        staves: [{ clef: "tab" }],
        content: {
          b1: {
            "0:0": [
              { id: "x1", value: 4, dots: 0, notes: { s6: { fret: 3 } } },
              { id: "x2", value: 4, dots: 0, notes: { s5: { fret: 5 } } },
            ],
          },
        },
      },
    ],
  };
}

function beatOf(doc: Y.Doc, index: number): YBeat {
  return contentOf(partsOf(doc).get("gtr")!).get("b1")!.get("0:0")!.get(index);
}

function notesOf(doc: Y.Doc, index: number): Y.Map<unknown> {
  return beatOf(doc, index).get("notes") as Y.Map<unknown>;
}

/** The band as its writer holds it once `write` has changed it, and as a member who receives it does. */
function bothSides(write: (doc: Y.Doc) => void): Y.Doc[] {
  const writer = jsonToDoc(band());
  write(writer);
  const receiver = new Y.Doc();
  Y.applyUpdate(receiver, Y.encodeStateAsUpdate(writer));
  return [writer, receiver];
}

/** What every side reads, the same for all. */
function readAlike(sides: Y.Doc[]) {
  const read = readScore(sides[0]!);
  for (const side of sides) expect(readScore(side)).toEqual(read);
  return read;
}

const atX2: Cursor = { partId: "gtr", barId: "b1", voice: "0:0", beatId: "x2", line: 6, at: "on" };

test("the limit is 64 levels: a list or an object is one, a number none", () => {
  expect(MAX_VALUE_DEPTH).toBe(64);
  expect(parsePlain(timeSigSchema, JSON.parse(`{"numerator":3,"denominator":4,"later":${nested(63)}}`)).success).toBe(true);
  expect(parsePlain(timeSigSchema, JSON.parse(`{"numerator":3,"denominator":4,"later":${nested(64)}}`)).success).toBe(false);
});

test("a field reading does not know, nested as deep as a value may be, is ignored by everyone and kept", () => {
  const sides = bothSides((doc) => {
    notesOf(doc, 0).set("s6", JSON.parse(`{"fret":3,"later":${nested(63)}}`));
    // A beat's field is a value of its own: 64 levels.
    beatOf(doc, 1).set("later", JSON.parse(nested(64)));
    beatOf(doc, 1).set("tuplet", JSON.parse(`{"actual":3,"normal":2,"later":${nested(63)}}`));
    barsOf(doc).get("b1")!.set("timeSig", JSON.parse(`{"numerator":3,"denominator":4,"later":${nested(63)}}`));
    partsOf(doc).get("gtr")!.set("staves", JSON.parse(`[{"clef":"tab","later":${nested(62)}}]`));
  });
  const { score, invalid } = readAlike(sides);
  expect(invalid).toEqual([]);
  expect(score.bars[0]!.timeSig).toEqual({ numerator: 3, denominator: 4 });
  expect(score.parts[0]!.content.b1!["0:0"]).toEqual([
    { id: "x1", value: 4, dots: 0, notes: { s6: { fret: 3 } } },
    { id: "x2", value: 4, dots: 0, tuplet: { actual: 3, normal: 2 }, notes: { s5: { fret: 5 } } },
  ]);
  expect(JSON.stringify(notesOf(sides[1]!, 0).get("s6"))).toBe(`{"fret":3,"later":${nested(63)}}`);
});

test("a value nested deeper than a value may be cannot be read by anyone, whatever field holds the depth", () => {
  const sides = bothSides((doc) => {
    notesOf(doc, 0).set("s6", JSON.parse(`{"fret":3,"later":${nested(64)}}`));
    beatOf(doc, 1).set("later", JSON.parse(nested(65)));
    barsOf(doc).get("b1")!.set("timeSig", JSON.parse(`{"numerator":3,"denominator":4,"later":${nested(64)}}`));
    partsOf(doc).get("gtr")!.set("name", JSON.parse(nested(500)));
  });
  const { score, invalid } = readAlike(sides);
  expect(score.bars[0]!.timeSig).toEqual({ numerator: 4, denominator: 4 });
  expect(score.parts[0]!.content.b1!["0:0"]).toEqual([{ id: "x1", value: 4, dots: 0, notes: {} }]);
  expect(invalid.map((flag) => flag.what)).toEqual(["bar.timeSig", "note", "beat", "part.name"]);
});

test("a value nested so deep that following it down would overflow the stack does not make its writer's reading throw", () => {
  // The others cannot even decode this one; its writer still reads the document.
  const deep = nested(20000);
  const doc = jsonToDoc(band());
  notesOf(doc, 1).set("s5", JSON.parse(`{"fret":5,"later":${deep}}`));
  beatOf(doc, 0).set("tuplet", JSON.parse(`{"actual":3,"normal":2,"later":${deep}}`));
  partsOf(doc).get("gtr")!.set("staves", JSON.parse(`[${deep}]`));
  const { score, invalid } = readScore(doc);
  expect(score.parts[0]!.content.b1!["0:0"]).toEqual([{ id: "x2", value: 4, dots: 0, notes: {} }]);
  expect(invalid.map((flag) => flag.what).sort()).toEqual(["beat", "note", "part.staves"]);
  expect(durationOf(beatOf(doc, 0))).toBeUndefined();
});

test("a command rewriting a note keeps the fields within the limit and drops those nested deeper, the same for everyone", () => {
  const stored = `{"fret":3,"kept":${nested(63)},"dropped":${nested(64)},"list":[${nested(62)}]}`;
  const sides = bothSides((doc) => notesOf(doc, 1).set("s6", JSON.parse(stored)));
  for (const side of sides) setFret(side, atX2, 5);
  for (const side of sides) expect(JSON.stringify(notesOf(side, 1).get("s6"))).toBe(`{"fret":5,"kept":${nested(63)},"list":[${nested(62)}]}`);
  readAlike(sides);
  expect(ownFields(JSON.parse(`{"a":1,"deep":${nested(20000)}}`))).toEqual({ a: 1 });
});

test("a note nested deeper than a value may be is not written, by any command", () => {
  const deep = JSON.parse(`{"fret":3,"later":${nested(64)}}`) as NoteJSON;
  const deepToggle: NoteToggle<void> = { decide: () => undefined, turn: () => deep };
  const doc = jsonToDoc(band());
  const transactions = transactionsOf(doc);
  setNote(doc, atX2, "s6", deep);
  setNote(doc, { ...atX2, at: "after" }, "s6", deep);
  toggleAt(doc, { ...atX2, line: 5 }, "s5", deepToggle);
  toggleOnSelection(doc, { kind: "bars", partId: "gtr", anchorBarId: "b1", focusBarId: "b1" }, atX2, deepToggle);
  expect(transactions.count).toBe(0);
  // One a level shallower is: as its own copy.
  setNote(doc, atX2, "s6", JSON.parse(`{"fret":3,"later":${nested(63)},"__proto__":{"ghost":true}}`) as NoteJSON);
  expect(JSON.stringify(notesOf(doc, 1).get("s6"))).toBe(`{"fret":3,"later":${nested(63)}}`);
});

test("a beat, a bar or a part nested deeper than a value may be is not made", () => {
  const doc = jsonToDoc(band());
  const transactions = transactionsOf(doc);
  const tuplet = JSON.parse(`{"actual":3,"normal":2,"later":${nested(64)}}`) as { actual: number; normal: number };
  expect(insertBeat(doc, atX2, { value: 8, tuplet })).toEqual(atX2);
  const deepMarking: BeatChange<void> = { decide: () => undefined, turn: () => ({ set: { text: JSON.parse(nested(65)) as string } }) };
  changeBeatAt(doc, atX2, deepMarking);
  const timeSig = JSON.parse(`{"numerator":3,"denominator":4,"later":${nested(64)}}`) as { numerator: number; denominator: 4 };
  expect(insertBars(doc, { after: "b1", count: 1, timeSig })).toEqual([]);
  expect(() => addPart(doc, { name: "Deep", kind: "pitched", staves: [JSON.parse(`{"clef":"bass","later":${nested(64)}}`) as { clef: "bass" }] })).toThrow(RangeError);
  expect(transactions.count).toBe(0);
});

test("an update is within the limit when every value it holds is; one that cannot be decoded is not, and checking it does not throw", () => {
  const at = (levels: number) => {
    const doc = new Y.Doc();
    doc.getMap("parts").set("deep", JSON.parse(nested(levels)));
    return Y.encodeStateAsUpdate(doc);
  };
  expect(updateWithinDepth(Y.encodeStateAsUpdate(jsonToDoc(band())))).toBe(true);
  expect(updateWithinDepth(at(64))).toBe(true);
  expect(updateWithinDepth(at(65))).toBe(false);
  // The same update as `at` makes, but too deep for anyone to decode.
  expect(updateWithinDepth(deepUpdate(64))).toBe(true);
  expect(() => Y.applyUpdate(new Y.Doc(), deepUpdate(100_000))).toThrow(RangeError);
  expect(updateWithinDepth(deepUpdate(100_000))).toBe(false);
});

test("a field named __proto__ is no level of a value, nor is it sent on: the others decode it as a prototype", () => {
  const writer = new Y.Doc();
  writer.getMap("parts").set("deep", JSON.parse(`{"fret":3,"__proto__":${nested(100)}}`));
  const update = Y.encodeStateAsUpdate(writer);
  expect(updateWithinDepth(update)).toBe(true);
  // As the server holds it and encodes it again for the others: without the __proto__.
  const server = new Y.Doc();
  Y.applyUpdate(server, update);
  const sent = new Y.Doc();
  Y.applyUpdate(sent, Y.encodeStateAsUpdate(server));
  expect(Object.getOwnPropertyNames(sent.getMap("parts").get("deep"))).toEqual(["fret"]);
  expect(Object.getPrototypeOf(sent.getMap("parts").get("deep"))).toBe(Object.prototype);
});

test("what is nested too deep in a document is taken out of it: the fields of an object within the limit kept, anything else removed", () => {
  const doc = jsonToDoc(band());
  notesOf(doc, 1).set("s6", JSON.parse(`{"fret":3,"kept":${nested(63)},"dropped":${nested(64)}}`));
  beatOf(doc, 1).set("later", JSON.parse(`[${nested(64)}]`));
  metaOf(doc).set("later", JSON.parse(nested(100)));
  const list = doc.getArray("elsewhere");
  list.push([1, JSON.parse(nested(65)), 2, JSON.parse(nested(64)), 3]);
  // As the server holds it: decoded from the stored state.
  const loaded = new Y.Doc();
  Y.applyUpdate(loaded, Y.encodeStateAsUpdate(doc));
  expect(updateWithinDepth(Y.encodeStateAsUpdate(loaded))).toBe(false);
  // Where each was, for the server's log.
  expect(dropTooDeep(loaded).sort()).toEqual(["elsewhere/1", "meta/later", "parts/gtr/content/b1/0:0/1/later", "parts/gtr/content/b1/0:0/1/notes/s6"]);
  expect(updateWithinDepth(Y.encodeStateAsUpdate(loaded))).toBe(true);
  expect(JSON.stringify(notesOf(loaded, 1).get("s6"))).toBe(`{"fret":3,"kept":${nested(63)}}`);
  expect(beatOf(loaded, 1).has("later")).toBe(false);
  // An object of one field, nested too deep: none of its fields kept.
  expect(metaOf(loaded).toJSON()).toEqual({ schemaVersion: SCHEMA_VERSION, title: "Demo", later: {} });
  expect(JSON.stringify(loaded.getArray("elsewhere").toJSON())).toBe(`[1,2,${nested(64)},3]`);
  // Nothing more to take out.
  expect(dropTooDeep(loaded)).toEqual([]);
  expect(readScore(loaded).invalid).toEqual([]);
});
