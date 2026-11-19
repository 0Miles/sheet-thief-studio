// Reading a document that holds what the schema does not allow (docs/spec/schema.md section 11):
// editors are trusted, so anything can be in it. Reading leaves it out, flags it, and never throws.
import fc from "fast-check";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { barsOf, contentOf, docToJson, emptyBarContent, jsonToDoc, metaOf, partsOf, readScore, SCHEMA_VERSION, type ScoreJSON, scoreSchema, type YBeat } from "../src/index";
import { score } from "./arbitraries";

/** Two bars, a six-string guitar with three beats in the first bar, and drums. */
function band() {
  const json: ScoreJSON = {
    schemaVersion: SCHEMA_VERSION,
    title: "Demo",
    bars: [
      { id: "b1", timeSig: { numerator: 4, denominator: 4 } },
      { id: "b2", timeSig: { numerator: 3, denominator: 4 }, tempo: 90 },
    ],
    parts: [
      {
        id: "gtr",
        name: "Guitar",
        kind: "fretted",
        tuning: [64, 59, 55, 50, 45, 40],
        capo: 2,
        program: 29,
        staves: [{ clef: "tab" }],
        content: {
          b1: {
            "0:0": [
              { id: "x1", value: 4, dots: 0, notes: { s6: { fret: 3 } } },
              { id: "x2", value: 4, dots: 0, notes: { s5: { fret: 5 }, s4: { fret: 7 } } },
              { id: "x3", value: 2, dots: 0, notes: {} },
            ],
          },
          b2: { "0:0": [{ id: "x4", value: 2, dots: 1, notes: { s1: { fret: 0 } } }] },
        },
      },
      { id: "drm", name: "Drums", kind: "percussion", tuning: [], capo: 0, program: 0, staves: [{ clef: "neutral" }], content: { b1: { "0:0": [] }, b2: { "0:0": [{ id: "k", value: 2, dots: 1, notes: { p36: {} } }] } } },
    ],
  };
  const doc = jsonToDoc(json);
  const part = (id: string) => partsOf(doc).get(id)!;
  const voice = (partId: string, barId: string, key = "0:0") => contentOf(part(partId)).get(barId)!.get(key)!;
  const beat = (index: number) => voice("gtr", "b1").get(index);
  const notes = (index: number) => beat(index).get("notes") as Y.Map<unknown>;
  return { doc, json, part, voice, beat, notes };
}

const ids = (json: ScoreJSON, part = 0, bar = "b1", voice = "0:0") => json.parts[part]!.content[bar]![voice]!.map((item) => item.id);

test("a beat that cannot be read is left out and flagged; the beats after it are read", () => {
  const { doc, beat } = band();
  beat(1).set("value", 3);
  const { score: json, invalid } = readScore(doc);
  expect(ids(json)).toEqual(["x1", "x3"]);
  expect(invalid).toEqual([{ kind: "invalidContent", partId: "gtr", barId: "b1", voice: "0:0", beatId: "x2", what: "beat" }]);
});

test("beats without notes, beats that are not maps, and beats with a field of another kind of part cannot be read", () => {
  const { doc, beat, voice } = band();
  beat(0).delete("notes");
  beat(2).set("lyric", "la");
  voice("gtr", "b1").insert(1, [{ id: "plain" } as unknown as YBeat]);
  const { score: json, invalid } = readScore(doc);
  expect(ids(json)).toEqual(["x2"]);
  expect(invalid.map((item) => [item.beatId, item.what])).toEqual([
    ["x1", "beat"],
    [undefined, "beat"],
    ["x3", "beat"],
  ]);
});

test("a note that cannot be read is left out of its beat and flagged; the other notes stay", () => {
  const { doc, notes } = band();
  notes(1).set("s4", { fret: 40 });
  notes(1).set("s7", { fret: 1 });
  notes(1).set("n60", {});
  notes(1).set("s3", new Y.Map());
  notes(1).set("s2", { dead: true, futureTechnique: "kept" });
  const { score: json, invalid } = readScore(doc);
  expect(json.parts[0]!.content.b1!["0:0"]![1]!.notes).toEqual({ s5: { fret: 5 }, s2: { dead: true } });
  expect(invalid.map((item) => [item.beatId, item.noteKey, item.what])).toEqual([
    ["x2", "n60", "note"],
    ["x2", "s3", "note"],
    ["x2", "s4", "note"],
    ["x2", "s7", "note"],
  ]);
  // What reading leaves out stays in the document as it is.
  expect(notes(1).get("s2")).toEqual({ dead: true, futureTechnique: "kept" });
});

test("slap and pop on the same beat read as slap alone, flagged", () => {
  const { doc, beat } = band();
  beat(0).set("slap", true);
  beat(0).set("pop", true);
  const { score: json, invalid } = readScore(doc);
  expect(json.parts[0]!.content.b1!["0:0"]![0]).toMatchObject({ id: "x1", slap: true });
  expect(json.parts[0]!.content.b1!["0:0"]![0]).not.toHaveProperty("pop");
  expect(invalid).toEqual([{ kind: "invalidContent", partId: "gtr", barId: "b1", voice: "0:0", beatId: "x1", what: "beat.pop" }]);
});

test("a time signature that cannot be read is 4/4, and the other bar fields are left out, each flagged", () => {
  const { doc } = band();
  const bar = barsOf(doc).get("b2")!;
  bar.set("timeSig", { numerator: 4, denominator: 5 });
  bar.set("tempo", 1000);
  bar.set("keySig", { fifths: 9, mode: "major" });
  bar.set("repeatStart", "yes");
  bar.set("repeatEnd", 1);
  bar.set("voltas", [3, 1]);
  bar.set("section", "");
  const { score: json, invalid } = readScore(doc);
  expect(json.bars[1]).toEqual({ id: "b2", timeSig: { numerator: 4, denominator: 4 } });
  expect(invalid.map((item) => [item.barId, item.what])).toEqual(
    ["timeSig", "tempo", "keySig", "repeatStart", "repeatEnd", "voltas", "section"].map((name) => ["b2", `bar.${name}`]),
  );
});

test("a pickup bar anywhere but first is ignored without a flag", () => {
  const { doc } = band();
  barsOf(doc).get("b2")!.set("anacrusis", true);
  barsOf(doc).get("b1")!.set("anacrusis", true);
  const { score: json, invalid } = readScore(doc);
  expect(json.bars.map((bar) => bar.anacrusis)).toEqual([true, undefined]);
  expect(invalid).toEqual([]);
});

test("a bar that cannot be placed in the score is left out of every part, so that the parts stay aligned", () => {
  const { doc } = band();
  barsOf(doc).get("b1")!.set("order", 7);
  barsOf(doc).set("junk", "not a bar" as unknown as Y.Map<unknown>);
  const { score: json, invalid } = readScore(doc);
  expect(json.bars.map((bar) => bar.id)).toEqual(["b2"]);
  expect(json.parts.map((part) => Object.keys(part.content))).toEqual([["b2"], ["b2"]]);
  expect(ids(json, 0, "b2")).toEqual(["x4"]);
  expect(invalid.map((item) => [item.barId, item.what]).sort()).toEqual([
    ["b1", "bar.order"],
    ["junk", "bar"],
  ]);
});

test("a part that cannot be placed in the score, a part whose content is not a map, and a bar content that is not a map are flagged", () => {
  const { doc, part } = band();
  partsOf(doc).set("junk", "not a part" as unknown as Y.Map<unknown>);
  part("drm").set("order", null);
  const first = readScore(doc);
  expect(first.score.parts.map((item) => item.id)).toEqual(["gtr"]);
  expect(first.invalid.map((item) => [item.partId, item.what]).sort()).toEqual([
    ["drm", "part.order"],
    ["junk", "part"],
  ]);

  const other = band();
  contentOf(other.part("gtr")).set("b1", [] as unknown as Y.Map<Y.Array<YBeat>>);
  other.part("drm").set("content", "none");
  const second = readScore(other.doc);
  expect(second.score.parts.map((item) => [item.id, Object.keys(item.content)])).toEqual([
    ["gtr", ["b2"]],
    ["drm", []],
  ]);
  expect(second.invalid).toEqual([
    { kind: "invalidContent", partId: "gtr", barId: "b1", what: "content" },
    { kind: "invalidContent", partId: "drm", what: "part.content" },
  ]);
});

test("a part of no known kind, or a fretted part with no tuning that can be read, is left out whole", () => {
  const { doc, part } = band();
  part("drm").set("kind", "brass");
  const first = readScore(doc);
  expect(first.score.parts.map((item) => item.id)).toEqual(["gtr"]);
  expect(first.invalid).toEqual([{ kind: "invalidContent", partId: "drm", what: "part.kind" }]);
  part("gtr").set("tuning", [64, 59]);
  const second = readScore(doc);
  expect(second.score.parts).toEqual([]);
  expect(second.invalid.map((item) => [item.partId, item.what])).toEqual([
    ["gtr", "part.tuning"],
    ["drm", "part.kind"],
  ]);
});

test("the other fields of a part that cannot be read take their defaults, each flagged", () => {
  const { doc, part } = band();
  part("gtr").set("name", 12);
  part("gtr").set("capo", 30);
  part("gtr").set("program", -1);
  part("gtr").set("staves", [{ clef: "treble" }]);
  part("drm").set("program", 25);
  const { score: json, invalid } = readScore(doc);
  expect(json.parts.map(({ name, capo, program, staves }) => ({ name, capo, program, staves }))).toEqual([
    { name: "", capo: 0, program: 25, staves: [{ clef: "tab" }] },
    { name: "Drums", capo: 0, program: 0, staves: [{ clef: "neutral" }] },
  ]);
  expect(ids(json)).toEqual(["x1", "x2", "x3"]);
  expect(invalid.map((item) => [item.partId, item.what])).toEqual([
    ["gtr", "part.staves"],
    ["gtr", "part.name"],
    ["gtr", "part.capo"],
    ["gtr", "part.program"],
    ["drm", "part.program"],
  ]);
});

test("a voice the part has no staff for, or that is not a list of beats, is left out and flagged", () => {
  const { doc, part } = band();
  const voices = contentOf(part("gtr")).get("b2")!;
  voices.set("1:0", new Y.Array<YBeat>());
  voices.set("0:2", new Y.Array<YBeat>());
  voices.set("0:1", "beats" as unknown as Y.Array<YBeat>);
  const { score: json, invalid } = readScore(doc);
  expect(json.parts[0]!.content.b2).toEqual({ "0:0": [{ id: "x4", value: 2, dots: 1, notes: { s1: { fret: 0 } } }] });
  expect(invalid.map((item) => [item.barId, item.voice, item.what]).sort()).toEqual([
    ["b2", "0:1", "voice"],
    ["b2", "0:2", "voice"],
    ["b2", "1:0", "voice"],
  ]);
});

test("fields reading does not know are ignored without a flag, and kept in the document", () => {
  const { doc, beat, part } = band();
  metaOf(doc).set("composer", "Someone");
  barsOf(doc).get("b1")!.set("swing", true);
  part("gtr").set("color", "red");
  beat(0).set("fermata", true);
  const { score: json, invalid } = readScore(doc);
  expect(invalid).toEqual([]);
  expect(json).toEqual(band().json);
  expect(beat(0).get("fermata")).toBe(true);
});

test("the meta fields that cannot be read are flagged: the title reads as empty, the artist as none", () => {
  const { doc } = band();
  metaOf(doc).set("title", "a".repeat(101));
  metaOf(doc).set("artist", "");
  metaOf(doc).set("schemaVersion", "one");
  const { score: json, invalid } = readScore(doc);
  expect([json.schemaVersion, json.title, json.artist]).toEqual([SCHEMA_VERSION, "", undefined]);
  expect(invalid.map((item) => item.what)).toEqual(["meta.schemaVersion", "meta.title", "meta.artist"]);
});

test("an empty document reads as an empty score of this version, with nothing flagged", () => {
  expect(readScore(new Y.Doc())).toEqual({ score: { schemaVersion: SCHEMA_VERSION, title: "", bars: [], parts: [] }, invalid: [] });
});

/** Every map and list inside a document, so that a test can write anything into any of them. */
function nodesOf(doc: Y.Doc): (Y.Map<unknown> | Y.Array<unknown>)[] {
  const nodes: (Y.Map<unknown> | Y.Array<unknown>)[] = [];
  const visit = (node: unknown): void => {
    if (!(node instanceof Y.Map || node instanceof Y.Array)) return;
    nodes.push(node);
    (node instanceof Y.Map ? [...node.values()] : node.toArray()).forEach(visit);
  };
  [metaOf(doc), barsOf(doc), partsOf(doc)].forEach(visit);
  return nodes;
}

const anything = fc.oneof(
  fc.jsonValue(),
  fc.constantFrom("ymap", "yarray").map((kind) => () => (kind === "ymap" ? new Y.Map() : new Y.Array())),
);
const names = fc.constantFrom("order", "timeSig", "tempo", "voltas", "kind", "tuning", "staves", "name", "content", "0:0", "0:1", "1:0", "id", "value", "dots", "tuplet", "notes", "slap", "pop", "s1", "s6", "p36", "n60", "title", "artist", "schemaVersion", "b1", "gtr");
const corruption = fc.record({ node: fc.nat(), name: names, value: fc.option(anything, { nil: undefined }) });

test("whatever is written anywhere in a document, reading does not throw and gives a legal score", () => {
  fc.assert(
    fc.property(score(), fc.array(corruption, { minLength: 1, maxLength: 8 }), (json, corruptions) => {
      const doc = jsonToDoc(json);
      for (const { node: index, name, value } of corruptions) {
        const nodes = nodesOf(doc);
        const node = nodes[index % nodes.length]!;
        const item = typeof value === "function" ? value() : value;
        if (node instanceof Y.Map) {
          if (item === undefined) node.delete(name);
          else node.set(name, item);
        } else if (item !== undefined) {
          node.insert(index % (node.length + 1), [item]);
        } else if (node.length > 0) {
          node.delete(index % node.length);
        }
      }
      const read = readScore(doc);
      expect(scoreSchema.safeParse(read.score).error?.issues ?? []).toEqual([]);
      expect(docToJson(doc)).toEqual(read.score);
    }),
    { numRuns: 30 },
  );
});

test("a bar whose id is __proto__ is left out of every part and flagged; a beat field of that name is ignored", () => {
  const { doc, part, beat } = band();
  const bar = new Y.Map<unknown>();
  bar.set("order", "z");
  bar.set("timeSig", { numerator: 2, denominator: 4 });
  barsOf(doc).set("__proto__", bar);
  contentOf(part("gtr")).set("__proto__", emptyBarContent(1));
  beat(0).set("__proto__", { pop: true });
  const { score: json, invalid } = readScore(doc);
  const content = json.parts[0]!.content;
  expect(json.bars.map((item) => item.id)).toEqual(["b1", "b2"]);
  expect(Object.getPrototypeOf(content)).toBe(Object.prototype);
  expect(Object.keys(content)).toEqual(["b1", "b2"]);
  expect(content.b1!["0:0"]![0]).toEqual({ id: "x1", value: 4, dots: 0, notes: { s6: { fret: 3 } } });
  expect(invalid).toEqual([{ kind: "invalidContent", barId: "__proto__", what: "bar" }]);
  // What reading gives can be written back: nothing in it is lost on the way.
  expect(docToJson(jsonToDoc(json))).toEqual(json);
});
