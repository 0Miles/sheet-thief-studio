// What a score's flags are (docs/spec/flags.md): computed from the score as plain data, never
// stored, in the order F8 goes through them.
import { expect, test } from "vitest";

import { type BeatJSON, type Cursor, type Flag, flagsOf, type InvalidContentFlag, nextFlag, type NoteJSON, type PartJSON, type ScoreJSON, stillAt } from "../src/index";

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

// F8 (docs/spec/flags.md, section 4): the cursor goes to the next flag, in the order of the list,
// from the first again after the last.
const at = (partId: string, barId: string, beatId: string | null, line = 1): Cursor => ({ partId, barId, voice: "0:0", beatId, at: beatId === null ? "after" : "on", line });

test("F8 goes from the cursor to the next flag after it in score order, and from the last back to the first", () => {
  const part = guitar("g", {
    a: full("a", { fret: 1 }, { fret: 1 }, { fret: 1 }),
    b: [quarter("b0", { s3: { fret: 1 } }), quarter("b1", { s2: { fret: 4, tie: true } })],
    c: [],
  });
  const json = score(part);
  const flags = flagsOf(json);
  expect(flags.map((flag) => flag.kind)).toEqual(["underfull", "danglingTie"]);
  // From bar a: the underfull bar b, its first beat, on the line the cursor was on.
  const bar = nextFlag(json, flags, at("g", "a", "a1", 4));
  expect(bar).toEqual({ flag: flags[0], cursor: at("g", "b", "b0", 4) });
  // Stopped there, the next is the tie on b's second beat, on its string.
  const tie = nextFlag(json, flags, at("g", "b", "b0", 4), { stopped: bar });
  expect(tie).toEqual({ flag: flags[1], cursor: at("g", "b", "b1", 2) });
  expect(stillAt(tie, at("g", "b", "b1", 2), flags)).toBe(true);
  // Moved onto the first beat of b without F8: past the bar's flag, the tie is next.
  expect(nextFlag(json, flags, at("g", "b", "b0"))?.flag).toEqual(flags[1]);
  // From the tie, or from anywhere after it: back to the first.
  expect(nextFlag(json, flags, at("g", "b", "b1", 2), { stopped: tie })?.flag).toEqual(flags[0]);
  // A stop the cursor has left is no longer one: on from the cursor.
  expect(stillAt(bar, at("g", "b", "b1", 2), flags)).toBe(false);
  expect(nextFlag(json, flags, at("g", "a", "a0"), { stopped: tie })?.flag).toEqual(flags[0]);
  expect(nextFlag(json, flags, at("g", "c", null))?.flag).toEqual(flags[0]);
  // Without a cursor (none yet), the first.
  expect(nextFlag(json, flags, null)?.flag).toEqual(flags[0]);
  expect(nextFlag(json, [], at("g", "a", "a0"))).toBeNull();
});

test("two flags on one beat are stopped at one after the other; a flag F8 stopped at that is gone goes on from where it was", () => {
  const part = guitar("g", { a: [quarter("a0", { s1: { fret: 1, tie: true }, s2: { fret: 2, tie: true } }), quarter("a1"), quarter("a2", { s3: { fret: 3, tie: true } })] });
  const json = score(part);
  const flags = flagsOf(json);
  expect(flags).toHaveLength(3);
  const first = nextFlag(json, flags, null)!;
  expect(first.cursor).toEqual(at("g", "a", "a0", 1));
  expect(nextFlag(json, flags, first.cursor, { stopped: first })).toEqual({ flag: flags[1], cursor: at("g", "a", "a0", 2) });
  // The first tie is untied: the flag F8 stopped at is no longer there.
  const untied = flagsOf(score(guitar("g", { a: [quarter("a0", { s1: { fret: 1 }, s2: { fret: 2, tie: true } }), quarter("a1"), quarter("a2", { s3: { fret: 3, tie: true } })] })));
  expect(stillAt(first, first.cursor, untied)).toBe(false);
  expect(nextFlag(json, untied, first.cursor, { stopped: first })?.flag).toEqual(untied[1]);
});

test("F8 does not stop where the cursor cannot go: the parts not given, a part or a bar not in the score, the score as a whole", () => {
  const first = guitar("g", { a: [quarter("a0", { s3: { fret: 1 } })] });
  const second = guitar("h", { b: [quarter("b0", { s3: { fret: 1 } })] });
  const json = score(first, second);
  const invalid: InvalidContentFlag[] = [
    { kind: "invalidContent", what: "meta.title" },
    { kind: "invalidContent", partId: "lost", what: "part.kind" },
    { kind: "invalidContent", partId: "g", barId: "gone", what: "bar" },
  ];
  const flags = flagsOf(json, invalid);
  expect(nextFlag(json, flags, null)?.cursor).toEqual(at("g", "a", "a0"));
  expect(nextFlag(json, flags, at("g", "a", "a0"))?.cursor).toEqual(at("h", "b", "b0"));
  // Only the first guitar is shown: F8 stays in it.
  expect(nextFlag(json, flags, at("g", "a", "a0"), { partIds: ["g"] })?.cursor).toEqual(at("g", "a", "a0"));
  // A part's invalid content goes to its first bar; one in a voice the part does not have, to its first voice.
  const named = flagsOf(json, [{ kind: "invalidContent", partId: "h", what: "part.name" }, { kind: "invalidContent", partId: "h", barId: "c", voice: "5:0", what: "voice" }]);
  expect(nextFlag(json, named, at("g", "a", "a0"), { partIds: ["h"] })?.cursor).toEqual(at("h", "a", null));
  expect(nextFlag(json, named, at("h", "b", "b0"), { partIds: ["h"] })?.cursor).toEqual(at("h", "c", null));
});
