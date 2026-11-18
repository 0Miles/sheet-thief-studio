// What a recognition turns into (docs/spec/recognizer.md, 7.2): the recognizer's intermediate
// model made a fragment of bars that passes the phrase schema, and the report of what it leaves
// out. The cases read the shared contract fixtures (services/recognizer/contract/fixtures/) and
// results built here.
import { type RecognizerBar, type RecognizerBeat, type RecognizerNote, type RecognizerResult, recognizerResult } from "@studio/contracts";
import { barsFragmentSchema } from "@studio/score-model";
import { expect, test } from "vitest";

import { fragmentOfRecognition } from "../src/recognitionFragment";
import { fixture, resultFixtures } from "./fakeRecognizer";

function note(fields: Partial<RecognizerNote> = {}): RecognizerNote {
  return {
    string: 1,
    fret: 0,
    dead: false,
    ghost: false,
    tie: false,
    vibrato: false,
    hammer: false,
    slide: false,
    slideShift: false,
    slideIn: null,
    slideOut: null,
    harmonic: null,
    tapped: false,
    graceFret: null,
    graceHammer: false,
    staccato: false,
    bendSemitones: 0,
    bendRelease: false,
    bendPre: false,
    letRing: false,
    palmMute: false,
    stroke: null,
    velocity: null,
    ...fields,
  };
}

function beat(notes: RecognizerNote[], fields: Partial<RecognizerBeat> = {}): RecognizerBeat {
  return { units: 8, tuplet: false, notes, ...fields };
}

function bar(beats: RecognizerBeat[], fields: Partial<RecognizerBar> = {}): RecognizerBar {
  return { timeSignature: null, marker: null, tempo: null, repeatOpen: false, repeatTimes: 0, endings: [], sign: null, jump: null, rhythmEstimated: false, beats, ...fields };
}

/** A six-string result read with its tuning, no capo, of these bars. */
function result(bars: RecognizerBar[], fields: Partial<RecognizerResult> = {}): RecognizerResult {
  return recognizerResult.parse({
    contract: "sheet-thief-studio/recognition",
    version: 1,
    strings: 6,
    tuning: { midi: [64, 59, 55, 50, 45, 40], source: "detected", reason: null, raw: null },
    capo: { fret: 0, source: "default" },
    timeSignature: { numerator: 4, denominator: 4 },
    bars,
    warnings: [],
    ...fields,
  });
}

/** The beats of the only voice of each bar. */
function beatsOf(recognized: RecognizerResult) {
  return fragmentOfRecognition(recognized).fragment.bars.map((each) => each.voices["0:0"]!);
}

test.each([...resultFixtures()])("the fixture %s turns into a fragment of bars that passes the phrase schema", (_, recognized) => {
  const { fragment } = fragmentOfRecognition(recognized);
  expect(barsFragmentSchema.safeParse(fragment).error).toBeUndefined();
  expect(fragment.kind).toBe("fretted");
  expect(fragment.tuning).toHaveLength(recognized.strings);
  expect(fragment.bars).toHaveLength(recognized.bars.length);
  expect(fragment.bars.map((each) => Object.keys(each.voices))).toEqual(recognized.bars.map(() => ["0:0"]));
});

test("strokes and dynamics of the notes become the beat's, a dynamic written only where it changes; grace notes are counted and dropped", () => {
  const recognized = fixture("grace-and-strokes") as RecognizerResult;
  const { fragment, report } = fragmentOfRecognition(recognized);
  const [first, second] = fragment.bars.map((each) => each.voices["0:0"]!);
  // Six notes down at 95; three up at 95 (the same dynamic: not written again); no stroke at 79, twice.
  expect(first!.map(({ stroke, dynamic }) => ({ stroke, dynamic }))).toEqual([
    { stroke: "down", dynamic: "f" },
    { stroke: "up", dynamic: undefined },
    { stroke: undefined, dynamic: "mf" },
    { stroke: undefined, dynamic: undefined },
  ]);
  // Two notes down and one up, one with none; two at 111 and two at 47, string 2 the lowest
  // numbered of them: p. Then a note with neither.
  expect(second!.map(({ stroke, dynamic }) => ({ stroke, dynamic }))).toEqual([
    { stroke: "down", dynamic: "p" },
    { stroke: undefined, dynamic: undefined },
  ]);
  // The grace notes are gone, the notes they lead to stay.
  expect(first![2]!.notes).toEqual({ s3: { fret: 7 } });
  expect(report.skipped).toEqual([{ code: "grace_notes", count: 3 }]);
  expect(report.warnings).toEqual([{ code: "other", params: {} }]);
});

test("a tie of strokes goes to the note on the lowest numbered string, whatever order the notes come in", () => {
  const [beats] = beatsOf(
    result([
      bar([
        beat([note({ string: 4, stroke: "down" }), note({ string: 2, stroke: "up" }), note({ string: 3, stroke: "down" }), note({ string: 1, stroke: "up" })]),
        beat([note({ string: 5, stroke: "down" }), note({ string: 6 }), note({ string: 2, stroke: "up" }), note({ string: 4, stroke: "down" })]),
        // Notes with none do not count against one that has one.
        beat([note({ string: 5 }), note({ string: 6 }), note({ string: 2, stroke: "up" })]),
      ]),
    ]),
  );
  expect(beats!.map((each) => each.stroke)).toEqual(["up", "down", "up"]);
});

test.each([
  [1, "pp"],
  [39, "pp"],
  [40, "p"],
  [55, "p"],
  [56, "mp"],
  [71, "mp"],
  [72, "mf"],
  [87, "mf"],
  [88, "f"],
  [103, "f"],
  [104, "ff"],
  [127, "ff"],
])("a velocity of %i is the dynamic %s", (velocity, dynamic) => {
  const [[only]] = beatsOf(result([bar([beat([note({ velocity })])])]));
  expect(only!.dynamic).toBe(dynamic);
});

test("a dynamic is written again after a rest only when it changes, across bars too", () => {
  const [first, second] = beatsOf(
    result([bar([beat([note({ velocity: 80 })]), beat([])]), bar([beat([note({ velocity: 80 })]), beat([note({ velocity: 100 })]), beat([note({ velocity: 100 })])])]),
  );
  expect(first!.map((each) => each.dynamic)).toEqual(["mf", undefined]);
  expect(second!.map((each) => each.dynamic)).toEqual([undefined, "f", undefined]);
});

test.each([
  [1, 32, 0],
  [2, 16, 0],
  [3, 16, 1],
  [4, 8, 0],
  [6, 8, 1],
  [7, 8, 2],
  [8, 4, 0],
  [12, 4, 1],
  [14, 4, 2],
  [16, 2, 0],
  [24, 2, 1],
  [28, 2, 2],
  [32, 1, 0],
  [48, 1, 1],
] as const)("%i 32nds are a note value of %i with %i dots", (units, value, dots) => {
  const [[only]] = beatsOf(result([bar([beat([note()], { units })])]));
  expect(only).toEqual({ value, dots, notes: { s1: { fret: 0 } } });
});

test("a triplet is 3 in the time of 2, and a beat with no notes a rest", () => {
  const [[triplet, rest]] = beatsOf(result([bar([beat([note()], { units: 4, tuplet: true }), beat([])])]));
  expect(triplet).toEqual({ value: 8, dots: 0, tuplet: { actual: 3, normal: 2 }, notes: { s1: { fret: 0 } } });
  expect(rest).toEqual({ value: 4, dots: 0, notes: {} });
});

test("a note keeps its marks under the score's names, and only those that are set", () => {
  const notes = [
    note({ string: 1, fret: 5, ghost: true, tie: true, vibrato: true, staccato: true, letRing: true, palmMute: true }),
    note({ string: 2, fret: null, dead: true }),
    note({ string: 3, fret: 7, tapped: true, harmonic: "pinch", hammer: true }),
    note({ string: 4, fret: 2, slide: true, slideOut: "up", slideIn: "below" }),
    note({ string: 5, fret: 2, slideShift: true, slideOut: "down", slideIn: "above" }),
    note({ string: 6, fret: 2, slideOut: "down" }),
  ];
  const [[only]] = beatsOf(result([bar([beat(notes)])]));
  expect(only!.notes).toEqual({
    s1: { fret: 5, ghost: true, tie: true, vibrato: true, staccato: true, letRing: true, palmMute: true },
    s2: { dead: true },
    s3: { fret: 7, tap: true, harmonic: "pinch", legato: true },
    s4: { fret: 2, slideOut: "legato", slideIn: "inBelow" },
    s5: { fret: 2, slideOut: "shift", slideIn: "inAbove" },
    s6: { fret: 2, slideOut: "outDown" },
  });
});

test("a slide that is both legato and shift is a shift slide, and one up out of the note is outUp", () => {
  const [[only]] = beatsOf(result([bar([beat([note({ string: 1, slide: true, slideShift: true }), note({ string: 2, slideOut: "up" })])])]));
  expect(only!.notes).toEqual({ s1: { fret: 0, slideOut: "shift" }, s2: { fret: 0, slideOut: "outUp" } });
});

test("bends take the shape their marks say, and a bend of more than 4 semitones is made 4 and counted", () => {
  const notes = [
    note({ string: 1, bendSemitones: 2 }),
    note({ string: 2, bendSemitones: 1, bendRelease: true }),
    note({ string: 3, bendSemitones: 3, bendPre: true }),
    note({ string: 4, bendSemitones: 4, bendPre: true, bendRelease: true }),
    note({ string: 5, bendSemitones: 5 }),
    note({ string: 6, bendSemitones: 0, bendRelease: true }),
  ];
  const recognized = result([bar([beat(notes)]), bar([beat([note({ bendSemitones: 12 })])])]);
  const { fragment, report } = fragmentOfRecognition(recognized);
  expect(fragment.bars[0]!.voices["0:0"]![0]!.notes).toEqual({
    s1: { fret: 0, bend: { type: "bend", semitones: 2 } },
    s2: { fret: 0, bend: { type: "bendRelease", semitones: 1 } },
    s3: { fret: 0, bend: { type: "preBend", semitones: 3 } },
    s4: { fret: 0, bend: { type: "preBendRelease", semitones: 4 } },
    s5: { fret: 0, bend: { type: "bend", semitones: 4 } },
    s6: { fret: 0 },
  });
  expect(fragment.bars[1]!.voices["0:0"]![0]!.notes).toEqual({ s1: { fret: 0, bend: { type: "bend", semitones: 4 } } });
  expect(report.skipped).toEqual([{ code: "bend_clamped", count: 2 }]);
});

test("each bar has the time signature in force: the song's until one is printed, then that one", () => {
  const recognized = result([bar([beat([])]), bar([beat([])], { timeSignature: { numerator: 7, denominator: 8 } }), bar([beat([])])], { timeSignature: { numerator: 3, denominator: 4 } });
  expect(fragmentOfRecognition(recognized).fragment.bars.map((each) => each.timeSig)).toEqual([
    { numerator: 3, denominator: 4 },
    { numerator: 7, denominator: 8 },
    { numerator: 7, denominator: 8 },
  ]);
});

test("a tuning read is kept, and a capo is reported as left out", () => {
  const { fragment, report } = fragmentOfRecognition(fixture("capo") as RecognizerResult);
  expect(fragment.kind === "fretted" && fragment.tuning).toEqual([64, 59, 55, 50, 45, 38]);
  expect(report).toMatchObject({ strings: 6, capo: { fret: 2, source: "detected" }, skipped: [{ code: "capo", fret: 2 }] });
});

test("a tuning not understood is reported with what was printed, and the fragment has the standard tuning of its strings", () => {
  const { fragment, report } = fragmentOfRecognition(fixture("tuning-unrecognized") as RecognizerResult);
  expect(fragment.kind === "fretted" && fragment.tuning).toEqual([64, 59, 55, 50, 45, 40]);
  expect(report.tuning).toEqual({ midi: [64, 59, 55, 50, 45, 40], source: "default", reason: "unrecognized", raw: "Standard, down 1/2 step" });
  expect(report.skipped).toEqual([{ code: "tuning_unrecognized", raw: "Standard, down 1/2 step" }]);
});

test.each([
  [4, [43, 38, 33, 28]],
  [5, [43, 38, 33, 28, 23]],
  [6, [64, 59, 55, 50, 45, 40]],
  [7, [64, 59, 55, 50, 45, 40, 35]],
])("with no tuning read, %i strings have the standard tuning %j, whatever the recognizer sent", (strings, tuning) => {
  const unread = Array.from({ length: strings }, () => 60);
  for (const read of [
    { midi: unread, source: "default", reason: "not_found", raw: null },
    { midi: unread, source: "default", reason: "unrecognized", raw: "Open G" },
  ] as const) {
    const { fragment } = fragmentOfRecognition(result([bar([beat([])])], { strings, tuning: read }));
    expect(fragment.kind === "fretted" && fragment.tuning).toEqual(tuning);
  }
});

test("section names, tempos, repeats, voltas, signs and jumps are left out and reported, once each", () => {
  expect(fragmentOfRecognition(fixture("six-strings") as RecognizerResult).report.skipped).toEqual([{ code: "sections" }, { code: "tempo" }, { code: "repeats" }]);
  expect(fragmentOfRecognition(fixture("seven-strings") as RecognizerResult).report.skipped).toEqual([{ code: "repeats" }, { code: "jumps" }]);
  const { fragment, report } = fragmentOfRecognition(
    result([
      bar([beat([])], { repeatOpen: true }),
      bar([beat([])], { endings: [1] }),
      bar([beat([])], { sign: "segno" }),
      bar([beat([])], { jump: "to_coda", marker: "B", tempo: 90 }),
      bar([beat([note({ graceFret: 1 }), note({ string: 2 })])]),
    ], { capo: { fret: 3, source: "detected" }, tuning: { midi: [64, 59, 55, 50, 45, 40], source: "default", reason: "unrecognized", raw: "?" } }),
  );
  expect(report.skipped).toEqual([
    { code: "grace_notes", count: 1 },
    { code: "capo", fret: 3 },
    { code: "tuning_unrecognized", raw: "?" },
    { code: "sections" },
    { code: "tempo" },
    { code: "repeats" },
    { code: "jumps" },
  ]);
  expect(fragment.bars.every((each) => Object.keys(each).sort().join() === "timeSig,voices")).toBe(true);
});
