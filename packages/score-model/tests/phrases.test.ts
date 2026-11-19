// Phrase fragments (docs/spec/phrases.md, section 1): their shape, taking one out of a score, and
// turning one into a score of a single part and back.
import fc from "fast-check";
import { expect, test } from "vitest";

import {
  type BarsFragment,
  barsFragmentSchema,
  beatsFragmentSchema,
  blankFragment,
  docToJson,
  fragmentOfBars,
  fragmentSchema,
  fragmentToScore,
  jsonBytes,
  jsonToDoc,
  MAX_FRAGMENT_BYTES,
  type PartJSON,
  type ScoreJSON,
  scoreSchema,
  scoreToFragment,
  withoutId,
} from "../src/index";
import { score } from "./arbitraries";

const GUITAR = [64, 59, 55, 50, 45, 40];

/** A legal fragment of each kind; every case below breaks one rule of one of them. */
const tab: BarsFragment = {
  kind: "fretted",
  tuning: GUITAR,
  bars: [
    { timeSig: { numerator: 4, denominator: 4 }, voices: { "0:0": [{ value: 4, dots: 0, notes: { s6: { fret: 3 } }, stroke: "down" }] } },
    { timeSig: { numerator: 3, denominator: 4 }, voices: { "0:0": [] } },
  ],
};
const groove: BarsFragment = { kind: "percussion", bars: [{ timeSig: { numerator: 4, denominator: 4 }, voices: { "0:0": [{ value: 8, dots: 0, notes: { p36: {} } }], "0:1": [] } }] };
const keys: BarsFragment = {
  kind: "pitched",
  staves: [{ clef: "treble" }, { clef: "bass" }],
  bars: [{ timeSig: { numerator: 4, denominator: 4 }, voices: { "0:0": [{ value: 2, dots: 1, notes: { n60: { spell: "C" } }, lyric: "la" }], "1:0": [] } }],
};

test("a fragment of bars of each kind passes, and so does a fragment of beats", () => {
  for (const fragment of [tab, groove, keys]) expect(barsFragmentSchema.safeParse(fragment).error?.issues ?? []).toEqual([]);
  const beats = { kind: "fretted", tuning: GUITAR, beats: [{ value: 8, dots: 0, notes: { s1: { fret: 0 } } }] };
  expect(beatsFragmentSchema.safeParse(beats).success).toBe(true);
  expect(beatsFragmentSchema.safeParse({ kind: "percussion", beats: [{ value: 8, dots: 0, notes: {} }] }).success).toBe(true);
  // The clipboard holds either, told apart by `bars` or `beats`.
  expect(fragmentSchema.parse(beats)).toEqual(beats);
  expect(fragmentSchema.parse(tab)).toEqual(tab);
});

test("a field a fragment does not know is left out, as reading leaves it out: a later version may add one", () => {
  const later = { ...tab, played: "loud", bars: [{ ...tab.bars[0]!, mood: "calm" }] };
  expect(barsFragmentSchema.parse(later)).toEqual({ ...tab, bars: [tab.bars[0]] });
});

test("a fragment holds no id, no tempo nor anything else a bar of the score has, and no capo", () => {
  const firstBar = tab.bars[0]!;
  const firstBeat = firstBar.voices["0:0"]![0]!;
  const broken: [string, unknown][] = [
    ["an id of the fragment", { ...tab, id: "p1" }],
    ["an id of a bar", { ...tab, bars: [{ ...firstBar, id: "b1" }] }],
    ["an id of a beat", { ...tab, bars: [{ ...firstBar, voices: { "0:0": [{ ...firstBeat, id: "x1" }] } }] }],
    ["a tempo", { ...tab, bars: [{ ...firstBar, tempo: 120 }] }],
    ["a key signature", { ...tab, bars: [{ ...firstBar, keySig: { fifths: 0, mode: "major" } }] }],
    ["a repeat", { ...tab, bars: [{ ...firstBar, repeatStart: true }] }],
    ["a section", { ...tab, bars: [{ ...firstBar, section: "Verse" }] }],
    ["a capo", { ...tab, capo: 2 }],
    ["an id of a beat in a fragment of beats", { kind: "fretted", tuning: GUITAR, beats: [{ ...firstBeat, id: "x1" }] }],
  ];
  for (const [what, fragment] of broken) expect(fragmentSchema.safeParse(fragment).success, what).toBe(false);
});

test("each kind carries what it needs and nothing of another kind", () => {
  const withoutStaves = { kind: keys.kind, bars: keys.bars };
  const withoutTuning = { kind: tab.kind, bars: tab.bars };
  const broken: [string, unknown][] = [
    ["pitched without staves", withoutStaves],
    ["pitched with three staves", { ...keys, staves: [{ clef: "treble" }, { clef: "bass" }, { clef: "bass" }] }],
    ["pitched with a tab staff", { ...keys, staves: [{ clef: "tab" }] }],
    ["fretted without a tuning", withoutTuning],
    ["fretted with three strings", { ...tab, tuning: [64, 59, 55] }],
    ["fretted with staves", { ...tab, staves: [{ clef: "tab" }] }],
    ["percussion with a tuning", { ...groove, tuning: GUITAR }],
    ["percussion with staves", { ...groove, staves: [{ clef: "neutral" }] }],
    ["a fragment of beats of drums with a tuning", { kind: "percussion", tuning: GUITAR, beats: [{ value: 8, dots: 0, notes: {} }] }],
    ["no bars", { ...tab, bars: [] }],
    ["no beats", { kind: "percussion", beats: [] }],
    ["a voice of a staff the fragment does not have", { ...tab, bars: [{ ...tab.bars[0]!, voices: { "1:0": [] } }] }],
    ["a note on a string the tuning does not have", { ...tab, bars: [{ ...tab.bars[0]!, voices: { "0:0": [{ value: 4, dots: 0, notes: { s7: { fret: 1 } } }] } }] }],
    ["a note of another kind", { ...groove, bars: [{ ...groove.bars[0]!, voices: { "0:0": [{ value: 4, dots: 0, notes: { s1: { fret: 1 } } }] } }] }],
    ["a beat field of another kind", { ...groove, bars: [{ ...groove.bars[0]!, voices: { "0:0": [{ value: 4, dots: 0, notes: {}, stroke: "up" }] } }] }],
    ["a fragment of beats with a note of another kind", { kind: "pitched", beats: [{ value: 4, dots: 0, notes: { p36: {} } }] }],
    ["both bars and beats", { ...tab, beats: [{ value: 4, dots: 0, notes: {} }] }],
  ];
  for (const [what, fragment] of broken) expect(fragmentSchema.safeParse(fragment).success, what).toBe(false);
});

/** Every id a score holds: of its bars, its parts and their beats. */
function idsOf(score: ScoreJSON): string[] {
  const beats = score.parts.flatMap((part) => Object.values(part.content).flatMap((voices) => Object.values(voices).flatMap((items) => items.map((beat) => beat.id))));
  return [...score.bars.map((bar) => bar.id), ...score.parts.map((part) => part.id), ...beats];
}

/** A legal score with a part and a bar, with a part of it and a range of its bars, either end first. */
const scoreAndRange = score({ maxBars: 4, maxParts: 2 })
  .filter((json) => json.bars.length > 0 && json.parts.length > 0)
  .chain((json) =>
    fc.record({
      json: fc.constant(json),
      part: fc.constantFrom(...json.parts),
      anchor: fc.integer({ min: 0, max: json.bars.length - 1 }),
      focus: fc.integer({ min: 0, max: json.bars.length - 1 }),
    }),
  );

test("bars taken out of a score and made a score of their own keep their music, each id made anew", () => {
  fc.assert(
    fc.property(scoreAndRange, ({ json, part, anchor, focus }) => {
      const fragment = fragmentOfBars(json, { partId: part.id, anchorBarId: json.bars[anchor]!.id, focusBarId: json.bars[focus]!.id })!;
      expect(barsFragmentSchema.safeParse(fragment).error?.issues ?? []).toEqual([]);

      const phrase = fragmentToScore(fragment);
      expect(scoreSchema.safeParse(phrase).error?.issues ?? []).toEqual([]);
      // The form docToJson gives, so that the phrase editor reads it back as it is.
      expect(docToJson(jsonToDoc(phrase))).toEqual(phrase);

      const taken = json.bars.slice(Math.min(anchor, focus), Math.max(anchor, focus) + 1);
      const [made] = phrase.parts;
      expect(phrase.bars.map((bar) => bar.timeSig)).toEqual(taken.map((bar) => bar.timeSig));
      expect([made!.kind, made!.tuning, made!.staves]).toEqual([part.kind, part.tuning, part.staves]);
      const music = (of: PartJSON, barIds: string[]) =>
        barIds.map((barId) => Object.fromEntries(Object.entries(of.content[barId] ?? {}).map(([voice, items]) => [voice, items.map(withoutId)])));
      expect(music(made!, phrase.bars.map((bar) => bar.id))).toEqual(music(part, taken.map((bar) => bar.id)));

      const before = new Set(idsOf(json));
      const after = idsOf(phrase);
      expect(after.filter((id) => before.has(id))).toEqual([]);
      expect(new Set(after).size).toBe(after.length);

      // And back: the score of the phrase is the same fragment again.
      expect(scoreToFragment(phrase)).toEqual(fragment);
    }),
    { numRuns: 40 },
  );
});

test("a range of bars that is not in the score gives no fragment, and only a score of one part and a bar is a phrase", () => {
  const json = fragmentToScore(tab);
  const [first, second] = json.bars;
  expect(fragmentOfBars(json, { partId: "elsewhere", anchorBarId: first!.id, focusBarId: second!.id })).toBeUndefined();
  expect(fragmentOfBars(json, { partId: json.parts[0]!.id, anchorBarId: first!.id, focusBarId: "gone" })).toBeUndefined();
  expect(() => scoreToFragment({ ...json, parts: [] })).toThrow();
  expect(() => scoreToFragment({ ...json, parts: [json.parts[0]!, { ...json.parts[0]!, id: "other" }] })).toThrow();
  expect(() => scoreToFragment({ ...json, bars: [], parts: [{ ...json.parts[0]!, content: {} }] })).toThrow();
});

test("a blank phrase is one empty bar of 4/4 for a part like the one given", () => {
  expect(blankFragment({ kind: "fretted", tuning: [43, 38, 33, 28], staves: [{ clef: "tab" }] })).toEqual({
    kind: "fretted",
    tuning: [43, 38, 33, 28],
    bars: [{ timeSig: { numerator: 4, denominator: 4 }, voices: { "0:0": [] } }],
  });
  expect(blankFragment({ kind: "percussion", tuning: [], staves: [{ clef: "neutral" }] })).toEqual({ kind: "percussion", bars: [{ timeSig: { numerator: 4, denominator: 4 }, voices: { "0:0": [] } }] });
  const blank = blankFragment({ kind: "pitched", tuning: [], staves: [{ clef: "treble" }, { clef: "bass" }] });
  expect(blank).toEqual({ kind: "pitched", staves: [{ clef: "treble" }, { clef: "bass" }], bars: [{ timeSig: { numerator: 4, denominator: 4 }, voices: { "0:0": [], "1:0": [] } }] });
  expect(barsFragmentSchema.safeParse(blank).success).toBe(true);
});

test("a fragment of more than 1 MB of JSON is refused", () => {
  const beat = { value: 64 as const, dots: 0 as const, notes: { s1: { fret: 12 } }, text: "譜".repeat(64) };
  const withBeats = (count: number): BarsFragment => ({ kind: "fretted", tuning: GUITAR, bars: [{ timeSig: { numerator: 4, denominator: 4 }, voices: { "0:0": Array(count).fill(beat) } }] });
  // The most beats that fit: each takes its own bytes and a comma, but the first.
  const fit = Math.floor((MAX_FRAGMENT_BYTES - jsonBytes(withBeats(0)) + 1) / (jsonBytes(beat) + 1));
  expect(jsonBytes(withBeats(fit))).toBeLessThanOrEqual(MAX_FRAGMENT_BYTES);
  expect(jsonBytes(withBeats(fit + 1))).toBeGreaterThan(MAX_FRAGMENT_BYTES);
  expect(barsFragmentSchema.safeParse(withBeats(fit)).success).toBe(true);
  expect(barsFragmentSchema.safeParse(withBeats(fit + 1)).success).toBe(false);
});
