// Values with a key of their own named __proto__ (#78). The member who writes one holds it as a
// key; the others, who decode it (lib0's readAny assigns key by key), hold it as the prototype of
// the value. Every member must read the same score, and values nested without end must not make
// reading throw.
import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  barsOf,
  contentOf,
  type Cursor,
  durationOf,
  fragmentSchema,
  importedScoreSchema,
  jsonToDoc,
  moveByBeat,
  parsePlain,
  partsOf,
  readBeatFields,
  readScore,
  SCHEMA_VERSION,
  type ScoreJSON,
  scoreSchema,
  staffCountOf,
  timeSigSchema,
  type YBeat,
} from "../src/index";

/** One bar of 4/4, a guitar with two quarter notes in it, and a piano with one. */
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
      { id: "pno", name: "Piano", kind: "pitched", tuning: [], capo: 0, program: 0, staves: [{ clef: "treble" }], content: { b1: { "0:0": [{ id: "k1", value: 4, dots: 0, notes: { n60: {} } }] } } },
    ],
  };
}

/** A value as a member writes it: parsed from JSON, so that a __proto__ in it is a key of its own. */
function written(json: string): unknown {
  return JSON.parse(json);
}

/** A value nested `levels` deep, as JSON. */
function nested(levels: number): string {
  return `${'{"in":'.repeat(levels)}1${"}".repeat(levels)}`;
}

/** Deep enough to tell a bounded check from one that follows the value down, and still a value the others can decode. */
const DEEP = nested(500);

interface Sides {
  writer: Y.Doc;
  receiver: Y.Doc;
}

/** The band as its writer holds it once `write` has changed it, and as a member who receives it does. */
function bothSides(write: (doc: Y.Doc) => void): Sides {
  const writer = jsonToDoc(band());
  write(writer);
  const receiver = new Y.Doc();
  Y.applyUpdate(receiver, Y.encodeStateAsUpdate(writer));
  return { writer, receiver };
}

function beatOf(doc: Y.Doc, index: number): YBeat {
  return contentOf(partsOf(doc).get("gtr")!).get("b1")!.get("0:0")!.get(index);
}

function notesOf(doc: Y.Doc, index: number): Y.Map<unknown> {
  return beatOf(doc, index).get("notes") as Y.Map<unknown>;
}

/** What the writer reads, the others reading the same score and the same flags. */
function readBySides({ writer, receiver }: Sides) {
  const read = readScore(writer);
  expect(readScore(receiver)).toEqual(read);
  return read;
}

test("a tuplet held under __proto__ makes its beat unreadable for the writer and for the others alike", () => {
  const sides = bothSides((doc) => beatOf(doc, 1).set("tuplet", written('{"__proto__":{"actual":3,"normal":2}}')));
  const { score, invalid } = readBySides(sides);
  expect(score.parts[0]!.content.b1!["0:0"]!.map((beat) => beat.id)).toEqual(["x1"]);
  expect(invalid).toEqual([{ kind: "invalidContent", partId: "gtr", barId: "b1", voice: "0:0", beatId: "x2", what: "beat" }]);
  for (const doc of [sides.writer, sides.receiver]) {
    expect(durationOf(beatOf(doc, 1))).toBeUndefined();
    expect(readBeatFields("fretted", beatOf(doc, 1))).toBeUndefined();
  }
});

test("a tuplet with its own fields and a __proto__ reads as its own fields for everyone", () => {
  const sides = bothSides((doc) => beatOf(doc, 1).set("tuplet", written('{"actual":3,"normal":2,"__proto__":{"actual":5,"normal":4}}')));
  const { score, invalid } = readBySides(sides);
  expect(score.parts[0]!.content.b1!["0:0"]![1]!.tuplet).toEqual({ actual: 3, normal: 2 });
  expect(invalid).toEqual([]);
  for (const doc of [sides.writer, sides.receiver]) expect(durationOf(beatOf(doc, 1))).toEqual({ value: 4, dots: 0, tuplet: { actual: 3, normal: 2 } });
});

test("the fields a note holds under __proto__ are not fields of the note, for anyone", () => {
  const sides = bothSides((doc) => {
    notesOf(doc, 0).set("s6", written('{"fret":3,"__proto__":{"ghost":true,"fret":9}}'));
    notesOf(doc, 1).set("s5", written('{"__proto__":{"fret":5}}'));
    notesOf(doc, 1).set("s4", written('{"fret":7,"bend":{"__proto__":{"type":"bend","semitones":2}}}'));
  });
  const { score, invalid } = readBySides(sides);
  const beats = score.parts[0]!.content.b1!["0:0"]!;
  expect(beats[0]!.notes).toEqual({ s6: { fret: 3 } });
  expect(beats[1]!.notes).toEqual({});
  expect(invalid.map((flag) => [flag.what, flag.noteKey])).toEqual([
    ["note", "s4"],
    ["note", "s5"],
  ]);
});

test("a time signature and a key signature under __proto__ read the same for everyone, and the cursor measures the bar the same", () => {
  const sides = bothSides((doc) => {
    const bar = barsOf(doc).get("b1")!;
    // A bar of 2/4 for those who would read the prototype: full, with no append slot.
    bar.set("timeSig", written('{"__proto__":{"numerator":2,"denominator":4}}'));
    bar.set("keySig", written('{"fifths":1,"__proto__":{"mode":"minor"}}'));
  });
  const { score, invalid } = readBySides(sides);
  expect(score.bars).toEqual([{ id: "b1", timeSig: { numerator: 4, denominator: 4 } }]);
  expect(invalid.map((flag) => flag.what)).toEqual(["bar.timeSig", "bar.keySig"]);
  // Two quarters do not fill the 4/4 the bar reads as: → reaches its append slot.
  const last: Cursor = { partId: "gtr", barId: "b1", voice: "0:0", beatId: "x2", line: 1, at: "on" };
  for (const doc of [sides.writer, sides.receiver]) expect(moveByBeat(doc, last, 1)).toMatchObject({ barId: "b1", beatId: "x2", at: "after" });
});

test("staves and a capo under __proto__ read the same, and every member counts as many staves", () => {
  const sides = bothSides((doc) => {
    partsOf(doc).get("pno")!.set("staves", written('[{"__proto__":{"clef":"treble"}},{"clef":"bass"}]'));
    partsOf(doc).get("gtr")!.set("capo", written('{"__proto__":2}'));
  });
  const { score, invalid } = readBySides(sides);
  expect(score.parts[1]!.staves).toEqual([{ clef: "treble" }]);
  expect(invalid.map((flag) => flag.what)).toEqual(["part.capo", "part.staves"]);
  for (const doc of [sides.writer, sides.receiver]) expect(staffCountOf(partsOf(doc).get("pno")!)).toBe(1);
});

test("a field reading does not know, nested without end, is ignored by everyone and reading does not throw", () => {
  const deep = DEEP;
  const sides = bothSides((doc) => {
    notesOf(doc, 0).set("s6", written(`{"fret":3,"later":${deep}}`));
    beatOf(doc, 1).set("later", written(deep));
    beatOf(doc, 1).set("tuplet", written(`{"actual":3,"normal":2,"later":${deep}}`));
    barsOf(doc).get("b1")!.set("timeSig", written(`{"numerator":3,"denominator":4,"later":${deep}}`));
    partsOf(doc).get("pno")!.set("staves", written(`[{"clef":"bass","later":${deep}}]`));
  });
  const { score, invalid } = readBySides(sides);
  expect(invalid).toEqual([]);
  expect(score.bars[0]!.timeSig).toEqual({ numerator: 3, denominator: 4 });
  expect(score.parts[0]!.content.b1!["0:0"]).toEqual([
    { id: "x1", value: 4, dots: 0, notes: { s6: { fret: 3 } } },
    { id: "x2", value: 4, dots: 0, tuplet: { actual: 3, normal: 2 }, notes: { s5: { fret: 5 } } },
  ]);
  expect(score.parts[1]!.staves).toEqual([{ clef: "bass" }]);
  // The document keeps what reading ignores.
  expect(JSON.stringify(notesOf(sides.receiver, 0).get("s6"))).toBe(`{"fret":3,"later":${deep}}`);
});

test("a value nested without end where reading knows the field is unreadable for everyone, and reading does not throw", () => {
  const deep = DEEP;
  const sides = bothSides((doc) => {
    notesOf(doc, 0).set("s6", written(`{"fret":3,"bend":${deep}}`));
    beatOf(doc, 1).set("tuplet", written(deep));
    barsOf(doc).get("b1")!.set("timeSig", written(deep));
    partsOf(doc).get("pno")!.set("staves", written(`[${deep}]`));
    partsOf(doc).get("gtr")!.set("name", written(deep));
  });
  const { score, invalid } = readBySides(sides);
  expect(score.parts[0]!.content.b1!["0:0"]).toEqual([{ id: "x1", value: 4, dots: 0, notes: {} }]);
  expect(invalid.map((flag) => flag.what)).toEqual(["bar.timeSig", "note", "beat", "part.name", "part.staves"]);
  for (const doc of [sides.writer, sides.receiver]) {
    expect(durationOf(beatOf(doc, 1))).toBeUndefined();
    expect(staffCountOf(partsOf(doc).get("pno")!)).toBe(1);
  }
});

test("a value nested so deep that following it down would overflow the stack does not make its writer's reading throw", () => {
  // The others cannot even decode this one (lib0's readAny follows it down); its writer still reads the document.
  const deep = nested(20000);
  const doc = jsonToDoc(band());
  notesOf(doc, 0).set("s6", written(`{"fret":3,"later":${deep}}`));
  notesOf(doc, 1).set("s5", written(`{"fret":5,"bend":${deep}}`));
  beatOf(doc, 0).set("tuplet", written(`{"actual":3,"normal":2,"later":${deep}}`));
  partsOf(doc).get("pno")!.set("staves", written(`[${deep}]`));
  const { score, invalid } = readScore(doc);
  expect(score.parts[0]!.content.b1!["0:0"]!.map((beat) => beat.notes)).toEqual([{ s6: { fret: 3 } }, {}]);
  expect(invalid.map((flag) => flag.what)).toEqual(["note", "part.staves"]);
  expect(staffCountOf(partsOf(doc).get("pno")!)).toBe(1);
  expect(durationOf(beatOf(doc, 0))).toEqual({ value: 4, dots: 0, tuplet: { actual: 3, normal: 2 } });
});

test("parsePlain reads the fields a value has of its own, whatever its prototype", () => {
  const received = Object.create({ numerator: 3, denominator: 8 }) as object;
  expect(timeSigSchema.safeParse(received).success).toBe(true);
  expect(parsePlain(timeSigSchema, received).success).toBe(false);
  expect(parsePlain(timeSigSchema, written('{"numerator":3,"denominator":8,"__proto__":{"numerator":2}}')).data).toEqual({ numerator: 3, denominator: 8 });
  expect(parsePlain(timeSigSchema, new Y.Map()).success).toBe(false);
  expect(parsePlain(timeSigSchema, null).success).toBe(false);
});

test("a score with a note, a voice or a bar content keyed __proto__ is refused, not read without it", () => {
  const breaks: ((json: ScoreJSON) => void)[] = [
    (json) => Object.defineProperty(json.parts[0]!.content.b1!["0:0"]![0]!.notes, "__proto__", { value: { fret: 1 }, enumerable: true }),
    (json) => Object.defineProperty(json.parts[0]!.content.b1, "__proto__", { value: [], enumerable: true }),
    (json) => Object.defineProperty(json.parts[0]!.content, "__proto__", { value: {}, enumerable: true }),
  ];
  for (const breakIt of breaks) {
    const json = band();
    breakIt(json);
    // As an imported file holds it: parsed from JSON.
    const imported = written(JSON.stringify(json));
    expect(JSON.stringify(imported)).toContain("__proto__");
    expect(scoreSchema.safeParse(imported).success).toBe(false);
    expect(importedScoreSchema.safeParse(imported).success).toBe(false);
  }
  expect(importedScoreSchema.safeParse(written(JSON.stringify(band()))).success).toBe(true);
});

test("a phrase fragment with a voice or a note keyed __proto__ is refused", () => {
  const fragment = (voices: string) => written(`{"kind":"pitched","staves":[{"clef":"treble"}],"bars":[{"timeSig":{"numerator":4,"denominator":4},"voices":${voices}}]}`);
  expect(fragmentSchema.safeParse(fragment('{"0:0":[{"value":4,"dots":0,"notes":{"n60":{}}}]}')).success).toBe(true);
  expect(fragmentSchema.safeParse(fragment('{"0:0":[{"value":4,"dots":0,"notes":{"n60":{},"__proto__":{}}}]}')).success).toBe(false);
  expect(fragmentSchema.safeParse(fragment('{"0:0":[{"value":4,"dots":0,"notes":{"n60":{}}}],"__proto__":[]}')).success).toBe(false);
});
