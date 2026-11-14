// What a score's flags are (docs/spec/flags.md): computed from the score as plain data, never
// stored, in the order F8 goes through them.
import { expect, test } from "vitest";

import { type BeatJSON, type Flag, flagsOf, type InvalidContentFlag, type NoteJSON, type PartJSON, type ScoreJSON } from "../src/index";

/** A quarter holding these notes. */
const quarter = (id: string, notes: Record<string, NoteJSON> = {}): BeatJSON => ({ id, value: 4, dots: 0, notes });

/** A guitar whose content is given by bar id, each bar's first voice holding the beats given. */
function guitar(id: string, content: Record<string, BeatJSON[]>): PartJSON {
  return {
    id,
    name: id,
    kind: "fretted",
    tuning: [64, 59, 55, 50, 45, 40],
    capo: 0,
    program: 25,
    staves: [{ clef: "tab" }],
    content: Object.fromEntries(Object.entries(content).map(([barId, beats]) => [barId, { "0:0": beats }])),
  };
}

/** A score of bars of 3/4 ("a", "b", "c"), with these parts. */
function score(...parts: PartJSON[]): ScoreJSON {
  const timeSig = { numerator: 3, denominator: 4 } as const;
  return { schemaVersion: 1, title: "Demo", bars: ["a", "b", "c"].map((id) => ({ id, timeSig })), parts };
}

/** Three quarters on string 3: a full bar of 3/4. */
const full = (prefix: string, ...notes: NoteJSON[]): BeatJSON[] => notes.map((note, index) => quarter(`${prefix}${index}`, { s3: note }));

const danglingTies = (flags: Flag[]) => flags.filter((flag) => flag.kind === "danglingTie");

test("a tie on the same string and fret as the note just before it, in its bar or the last of the bar before, is not flagged", () => {
  const flags = flagsOf(score(guitar("g", { a: full("a", { fret: 5 }, { fret: 5, tie: true }, { fret: 7 }), b: full("b", { fret: 7, tie: true }, { fret: 7, tie: true }, { fret: 2 }) })));
  expect(flags).toEqual([]);
});

test("a tie on another fret than the note before is dangling, in its bar as from the bar before", () => {
  const flags = flagsOf(score(guitar("g", { a: full("a", { fret: 5 }, { fret: 6, tie: true }, { fret: 7 }), b: full("b", { fret: 8, tie: true }, { fret: 1 }, { fret: 1 }) })));
  expect(flags).toEqual([
    { kind: "danglingTie", partId: "g", barId: "a", voice: "0:0", beatId: "a1", noteKey: "s3" },
    { kind: "danglingTie", partId: "g", barId: "b", voice: "0:0", beatId: "b0", noteKey: "s3" },
  ]);
});

test("a tie with no note before it is dangling: the first beat of the score, after a rest, after a beat without that string, after an empty bar", () => {
  const part = guitar("g", {
    a: [quarter("a0", { s3: { fret: 5, tie: true } }), quarter("a1"), quarter("a2", { s3: { fret: 5, tie: true } })],
    b: [quarter("b0", { s2: { fret: 5 } }), quarter("b1", { s3: { fret: 5, tie: true } }), quarter("b2", { s3: { fret: 5 } })],
    c: [quarter("c0", { s3: { fret: 5, tie: true } }), quarter("c1"), quarter("c2")],
  });
  expect(danglingTies(flagsOf(score(part))).map((flag) => "beatId" in flag && flag.beatId)).toEqual(["a0", "a2", "b1"]);
  // The bar before the first beat of c is b, whose last beat holds fret 5 on string 3; emptied, there is no note before it.
  part.content.b = { "0:0": [] };
  expect(danglingTies(flagsOf(score(part))).map((flag) => "beatId" in flag && flag.beatId)).toEqual(["a0", "a2", "c0"]);
});

test("the note before is looked for in the same voice of the same part only", () => {
  const first = guitar("g", { a: full("a", { fret: 5 }, { fret: 5 }, { fret: 5 }) });
  const second = guitar("h", { a: [], b: full("b", { fret: 5, tie: true }, { fret: 5 }, { fret: 5 }) });
  // Bar a of the second guitar is empty: what the first guitar holds there does not count.
  expect(danglingTies(flagsOf(score(first, second)))).toEqual([{ kind: "danglingTie", partId: "h", barId: "b", voice: "0:0", beatId: "b0", noteKey: "s3" }]);
  const voices = guitar("g", { a: [] });
  voices.content.a = { "0:0": [quarter("x", { s3: { fret: 5 } })], "0:1": [quarter("y", { s3: { fret: 5, tie: true } })] };
  expect(danglingTies(flagsOf(score(voices))).map((flag) => "beatId" in flag && [flag.voice, flag.beatId])).toEqual([["0:1", "y"]]);
});

test("on a pitched part, a tie continues the same pitch on the beat before", () => {
  const bass: PartJSON = {
    id: "p",
    name: "p",
    kind: "pitched",
    tuning: [],
    capo: 0,
    program: 0,
    staves: [{ clef: "treble" }],
    content: { a: { "0:0": [quarter("a0", { n60: {} }), quarter("a1", { n60: { tie: true } }), quarter("a2", { n62: { tie: true } })] } },
  };
  expect(danglingTies(flagsOf(score(bass)))).toEqual([{ kind: "danglingTie", partId: "p", barId: "a", voice: "0:0", beatId: "a2", noteKey: "n62" }]);
});

test("a first bar that is a pickup is not underfull; it is still overfull, and a later bar is underfull", () => {
  const part = guitar("g", { a: [quarter("a0", { s3: { fret: 1 } })], b: [quarter("b0", { s3: { fret: 1 } })] });
  const pickup = score(part);
  pickup.bars[0]!.anacrusis = true;
  expect(flagsOf(pickup)).toEqual([{ kind: "underfull", partId: "g", barId: "b", voice: "0:0" }]);
  part.content.a = { "0:0": full("a", { fret: 1 }, { fret: 1 }, { fret: 1 }, { fret: 1 }) };
  expect(flagsOf(pickup)).toEqual([
    { kind: "overfull", partId: "g", barId: "a", voice: "0:0" },
    { kind: "underfull", partId: "g", barId: "b", voice: "0:0" },
  ]);
});

test("flags come in score order, the invalid content read among them: by part, bar, voice, then beat", () => {
  const first = guitar("g", { a: [quarter("a0", { s3: { fret: 5, tie: true } })], b: full("b", { fret: 1 }, { fret: 1 }, { fret: 1 }) });
  first.content.b!["0:1"] = [quarter("v0", { s3: { fret: 2, tie: true } })];
  const second = guitar("h", { a: [quarter("h0", { s1: { fret: 1 } })] });
  const invalid: InvalidContentFlag[] = [
    { kind: "invalidContent", partId: "h", barId: "a", voice: "0:0", beatId: "gone", what: "beat" },
    { kind: "invalidContent", partId: "g", barId: "b", voice: "0:0", beatId: "b1", noteKey: "s9", what: "note" },
    { kind: "invalidContent", partId: "lost", what: "part.kind" },
    { kind: "invalidContent", barId: "c", what: "bar.timeSig" },
    { kind: "invalidContent", partId: "g", what: "part.name" },
    { kind: "invalidContent", what: "meta.title" },
  ];
  expect(flagsOf(score(first, second), invalid)).toEqual([
    { kind: "invalidContent", what: "meta.title" },
    { kind: "invalidContent", barId: "c", what: "bar.timeSig" },
    { kind: "invalidContent", partId: "g", what: "part.name" },
    { kind: "underfull", partId: "g", barId: "a", voice: "0:0" },
    { kind: "danglingTie", partId: "g", barId: "a", voice: "0:0", beatId: "a0", noteKey: "s3" },
    { kind: "invalidContent", partId: "g", barId: "b", voice: "0:0", beatId: "b1", noteKey: "s9", what: "note" },
    { kind: "underfull", partId: "g", barId: "b", voice: "0:1" },
    { kind: "danglingTie", partId: "g", barId: "b", voice: "0:1", beatId: "v0", noteKey: "s3" },
    { kind: "underfull", partId: "h", barId: "a", voice: "0:0" },
    { kind: "invalidContent", partId: "h", barId: "a", voice: "0:0", beatId: "gone", what: "beat" },
    { kind: "invalidContent", partId: "lost", what: "part.kind" },
  ]);
});
