// The shape of a score as plain data (docs/spec/schema.md): what is legal and every limit.
import fc from "fast-check";
import { expect, test } from "vitest";

import { importedScoreSchema, MAX_BARS, MAX_IMPORT_BYTES, SCHEMA_VERSION, type ScoreJSON, scoreSchema } from "../src/index";
import { score } from "./arbitraries";

test("every legal score passes the schema", () => {
  fc.assert(
    fc.property(score(), (json) => {
      const parsed = scoreSchema.safeParse(json);
      expect(parsed.error?.issues ?? []).toEqual([]);
    }),
    { numRuns: 300 },
  );
});

/** A small legal score with one part of each kind; every case below breaks one rule of it. */
function band(): ScoreJSON {
  return {
    schemaVersion: SCHEMA_VERSION,
    title: "Demo",
    artist: "The Band",
    bars: [
      { id: "b1", timeSig: { numerator: 4, denominator: 4 }, tempo: 120, anacrusis: true },
      { id: "b2", timeSig: { numerator: 3, denominator: 4 }, keySig: { fifths: -3, mode: "minor" }, repeatStart: true, repeatEnd: 2, voltas: [1, 2], section: "Verse" },
    ],
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
          b1: { "0:0": [{ id: "x1", value: 4, dots: 0, notes: { s6: { fret: 3, palmMute: true }, s5: { dead: true } }, stroke: "down", slap: true }] },
          b2: { "0:0": [] },
        },
      },
      {
        id: "drm",
        name: "Drums",
        kind: "percussion",
        tuning: [],
        capo: 0,
        program: 0,
        staves: [{ clef: "neutral" }],
        content: { b1: { "0:0": [{ id: "x2", value: 8, dots: 1, notes: { p36: {}, p127: { ghost: true } } }], "0:1": [{ id: "x3", value: 2, dots: 0, notes: { p44: {} } }] }, b2: { "0:0": [] } },
      },
      {
        id: "key",
        name: "Keys",
        kind: "pitched",
        tuning: [],
        capo: 0,
        program: 0,
        staves: [{ clef: "treble" }, { clef: "bass" }],
        content: {
          b1: { "0:0": [{ id: "x4", value: 4, dots: 0, tuplet: { actual: 3, normal: 2 }, notes: { n61: { spell: "Db", tie: true } }, lyric: "", text: "Dm7" }], "1:0": [] },
          b2: { "0:0": [], "1:0": [], "1:1": [{ id: "x5", value: 1, dots: 0, notes: { n0: {} }, dynamic: "ff" }] },
        },
      },
    ],
  };
}

type Part = ScoreJSON["parts"][number];
const guitar = (json: ScoreJSON) => json.parts[0] as Extract<Part, { kind: "fretted" }>;
const drums = (json: ScoreJSON) => json.parts[1] as Extract<Part, { kind: "percussion" }>;
const keys = (json: ScoreJSON) => json.parts[2] as Extract<Part, { kind: "pitched" }>;
const beatOf = (part: Part, bar = "b1", voice = "0:0") => part.content[bar]![voice]![0]!;
/** Make a part of each kind so that the score holds more of them. */
const copies = (part: Part, count: number, prefix: string) => Array.from({ length: count }, (_, index) => ({ ...part, id: `${prefix}${index}`, content: {} }));

test("the band itself is legal", () => {
  expect(scoreSchema.safeParse(band()).error?.issues ?? []).toEqual([]);
});

const broken: [string, (json: ScoreJSON) => void][] = [
  // meta
  ["a title of 101 characters", (json) => void (json.title = "a".repeat(101))],
  ["a title of 51 emoji (102 UTF-16 units)", (json) => void (json.title = "😀".repeat(51))],
  ["an artist of 101 characters", (json) => void (json.artist = "a".repeat(101))],
  ["an empty artist", (json) => void (json.artist = "")],
  ["a schema version that is not an integer", (json) => void (json.schemaVersion = 1.5)],
  // bars
  [`more than ${MAX_BARS} bars`, (json) => void (json.bars = Array.from({ length: MAX_BARS + 1 }, (_, index) => ({ id: `b${index}`, timeSig: { numerator: 4, denominator: 4 } })))],
  ["two bars with the same id", (json) => void (json.bars[1]!.id = "b1")],
  ["a numerator of 33", (json) => void (json.bars[0]!.timeSig.numerator = 33)],
  ["a numerator of 0", (json) => void (json.bars[0]!.timeSig.numerator = 0)],
  ["a denominator of 3", (json) => void (json.bars[0]!.timeSig.denominator = 3 as 4)],
  ["a denominator of 64", (json) => void (json.bars[0]!.timeSig.denominator = 64 as 4)],
  ["a tempo of 19", (json) => void (json.bars[0]!.tempo = 19)],
  ["a tempo of 401", (json) => void (json.bars[0]!.tempo = 401)],
  ["a key of eight sharps", (json) => void (json.bars[1]!.keySig = { fifths: 8, mode: "major" })],
  ["a key in a mode other than major or minor", (json) => void (json.bars[1]!.keySig = { fifths: 0, mode: "dorian" as "major" })],
  ["a repeat played once", (json) => void (json.bars[1]!.repeatEnd = 1)],
  ["a repeat played 33 times", (json) => void (json.bars[1]!.repeatEnd = 33)],
  ["a repeat start that is not true", (json) => void (json.bars[1]!.repeatStart = false as true)],
  ["no volta in the list", (json) => void (json.bars[1]!.voltas = [])],
  ["voltas out of order", (json) => void (json.bars[1]!.voltas = [2, 1])],
  ["the same volta twice", (json) => void (json.bars[1]!.voltas = [1, 1])],
  ["a ninth volta", (json) => void (json.bars[1]!.voltas = [9])],
  ["a section of 65 characters", (json) => void (json.bars[1]!.section = "a".repeat(65))],
  ["an empty section", (json) => void (json.bars[1]!.section = "")],
  ["a pickup bar that is not the first", (json) => void (json.bars[1]!.anacrusis = true)],
  ["content for a bar that is not in the score", (json) => void (guitar(json).content.gone = { "0:0": [] })],
  // parts
  ["17 parts", (json) => void json.parts.push(...copies(drums(json), 14, "d"))],
  ["16 parts that are not drums", (json) => void (json.parts = [...copies(guitar(json), 8, "g"), ...copies(keys(json), 8, "k")])],
  ["two parts with the same id", (json) => void (json.parts[1]!.id = "gtr")],
  ["a part name of 65 characters", (json) => void (json.parts[0]!.name = "a".repeat(65))],
  ["a part of an unknown kind", (json) => void (json.parts[0]!.kind = "brass" as "fretted")],
  ["a fretted part of three strings", (json) => void (guitar(json).tuning = [64, 59, 55])],
  ["a fretted part of eight strings", (json) => void (guitar(json).tuning = [64, 59, 55, 50, 45, 40, 35, 30])],
  ["an open string above MIDI 127", (json) => void (guitar(json).tuning[0] = 128)],
  ["a capo on fret 25", (json) => void (guitar(json).capo = 25)],
  ["a program of 128", (json) => void (guitar(json).program = 128)],
  ["a fretted part in standard notation", (json) => void (guitar(json).staves = [{ clef: "treble" as "tab" }])],
  ["drums with a tuning", (json) => void (drums(json).tuning = [36] as unknown as [])],
  ["drums with a capo", (json) => void (drums(json).capo = 1 as 0)],
  ["drums on a program other than 0", (json) => void (drums(json).program = 1 as 0)],
  ["a pitched part with a capo", (json) => void (keys(json).capo = 2 as 0)],
  ["a pitched part of three staves", (json) => void keys(json).staves.push({ clef: "treble" })],
  ["a pitched part with no staff", (json) => void (keys(json).staves = [])],
  ["a pitched part in tablature", (json) => void (keys(json).staves[0] = { clef: "tab" as "treble" })],
  // voices
  ["a voice on a staff the part does not have", (json) => void (guitar(json).content.b1!["1:0"] = [])],
  ["a third voice", (json) => void (guitar(json).content.b1!["0:2"] = [])],
  ["a voice key that is not staff:voice", (json) => void (guitar(json).content.b1!.main = [])],
  // beats
  ["a note value of 3", (json) => void (beatOf(guitar(json)).value = 3 as 4)],
  ["three dots", (json) => void (beatOf(guitar(json)).dots = 3 as 2)],
  ["a tuplet of 3 in the time of 3", (json) => void (beatOf(guitar(json)).tuplet = { actual: 3, normal: 3 })],
  ["a tuplet of 13", (json) => void (beatOf(guitar(json)).tuplet = { actual: 13, normal: 8 })],
  ["slap and pop on the same beat", (json) => void (beatOf(guitar(json)).pop = true)],
  ["a stroke on a drum beat", (json) => void (beatOf(drums(json)).stroke = "up")],
  ["a lyric on a guitar beat", (json) => void (beatOf(guitar(json)).lyric = "la")],
  ["a lyric of 33 characters", (json) => void (beatOf(keys(json)).lyric = "a".repeat(33))],
  ["a beat text of 65 characters", (json) => void (beatOf(keys(json)).text = "a".repeat(65))],
  ["an empty beat text", (json) => void (beatOf(keys(json)).text = "")],
  ["a dynamic of fff", (json) => void (beatOf(keys(json)).dynamic = "fff" as "ff")],
  // notes
  ["a note on string 7 of a six-string guitar", (json) => void (beatOf(guitar(json)).notes.s7 = { fret: 0 })],
  ["a note on string 0", (json) => void (beatOf(guitar(json)).notes.s0 = { fret: 0 })],
  ["a string key with a leading zero", (json) => void (beatOf(guitar(json)).notes.s01 = { fret: 0 })],
  ["a pitch key on a guitar", (json) => void (beatOf(guitar(json)).notes.n60 = {})],
  ["drum piece 128", (json) => void (beatOf(drums(json)).notes.p128 = {})],
  ["pitch 128", (json) => void (beatOf(keys(json)).notes.n128 = {})],
  ["fret 37", (json) => void (beatOf(guitar(json)).notes.s6 = { fret: 37 })],
  ["a fretted note with no fret that is not dead", (json) => void (beatOf(guitar(json)).notes.s6 = { palmMute: true })],
  ["a bend of five semitones", (json) => void (beatOf(guitar(json)).notes.s6 = { fret: 5, bend: { type: "bend", semitones: 5 } })],
  ["a slide of an unknown kind", (json) => void (beatOf(guitar(json)).notes.s6 = { fret: 5, slideOut: "down" as "shift" })],
  ["a dead note marked false", (json) => void (beatOf(guitar(json)).notes.s6 = { fret: 5, dead: false as true })],
  ["a fret on a drum", (json) => void (beatOf(drums(json)).notes.p36 = { fret: 1 })],
  ["a tie on a drum", (json) => void (beatOf(drums(json)).notes.p36 = { tie: true })],
  ["palm mute on a pitched note", (json) => void (beatOf(keys(json)).notes.n61 = { palmMute: true })],
  ["a spelling on a guitar note", (json) => void (beatOf(guitar(json)).notes.s6 = { fret: 3, spell: "G" })],
  ["the spelling H", (json) => void (beatOf(keys(json)).notes.n61 = { spell: "H" })],
  ["a spelling with three sharps", (json) => void (beatOf(keys(json)).notes.n61 = { spell: "C###" })],
];

test.each(broken)("the schema rejects %s", (_, breakIt) => {
  const json = band();
  breakIt(json);
  expect(scoreSchema.safeParse(json).success).toBe(false);
});

test("lengths are counted in UTF-16 code units, at the limit included", () => {
  const json = band();
  json.title = "a".repeat(100);
  json.artist = "😀".repeat(50);
  json.bars[1]!.section = "😀".repeat(32);
  beatOf(keys(json)).lyric = "a".repeat(32);
  expect(scoreSchema.safeParse(json).success).toBe(true);
});

test("fields the schema does not know are left out, not refused", () => {
  const json = band() as ScoreJSON & { composer: string };
  json.composer = "Someone";
  beatOf(guitar(json)).notes.s6 = { fret: 3, futureTechnique: true } as never;
  const parsed = scoreSchema.parse(json);
  expect(parsed).not.toHaveProperty("composer");
  expect(beatOf(parsed.parts[0]!).notes.s6).toEqual({ fret: 3 });
});

/** A legal score of 1000 bars whose beats carry 64 CJK characters of text each (3 bytes apiece in UTF-8). */
function wordy(beatsPerBar: number): ScoreJSON {
  const bars = Array.from({ length: MAX_BARS }, (_, index) => ({ id: `b${index}`, timeSig: { numerator: 4, denominator: 4 as const } }));
  const beats = (barId: string) => Array.from({ length: beatsPerBar }, (_, index) => ({ id: `${barId}x${index}`, value: 64 as const, dots: 0 as const, notes: {}, text: "譜".repeat(64) }));
  return {
    schemaVersion: SCHEMA_VERSION,
    title: "Wordy",
    bars,
    parts: [{ id: "gtr", name: "Guitar", kind: "fretted", tuning: [64, 59, 55, 50, 45, 40], capo: 0, program: 25, staves: [{ clef: "tab" }], content: Object.fromEntries(bars.map(({ id }) => [id, { "0:0": beats(id) }])) }],
  };
}

test("a score to import may take up to 5 MB once serialized, counted in UTF-8 bytes", () => {
  const large = wordy(22);
  // Every character is one byte but the 64 CJK characters of each beat, three bytes each.
  const characters = JSON.stringify(large).length;
  const bytes = characters + 2 * 64 * 22 * MAX_BARS;
  // Over 5 MB in UTF-8, though under it counted in JavaScript characters.
  expect(bytes).toBeGreaterThan(MAX_IMPORT_BYTES);
  expect(characters).toBeLessThan(MAX_IMPORT_BYTES);
  expect(scoreSchema.safeParse(large).success).toBe(true);
  expect(importedScoreSchema.safeParse(large).success).toBe(false);
  expect(importedScoreSchema.safeParse(wordy(20)).success).toBe(true);
});
