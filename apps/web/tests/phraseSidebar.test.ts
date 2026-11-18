// The phrase sidebar's choices (docs/spec/phrases.md, section 6): which phrases fit the cursor's
// part, and where a phrase dragged over the score would go.
import { blankFragment, type Cursor, PART_PRESETS, type ScoreJSON } from "@studio/score-model";
import { describe, expect, test } from "vitest";

import { dropSpotOf, fitsPart, phraseContents, phrasesShown } from "../src/phraseSidebar";

const GUITAR = { kind: "fretted" as const, tuning: [64, 59, 55, 50, 45, 40], staves: [{ clef: "tab" as const }] };
const BASS = { kind: "fretted" as const, tuning: [43, 38, 33, 28], staves: [{ clef: "tab" as const }] };
const DRUMS = { kind: "percussion" as const, tuning: [], staves: [{ clef: "neutral" as const }] };
const PIANO = { kind: "pitched" as const, tuning: [], staves: [{ clef: "treble" as const }, { clef: "bass" as const }] };
const MELODY = { kind: "pitched" as const, tuning: [], staves: [{ clef: "treble" as const }] };

const phrase = (kind: "fretted" | "percussion" | "pitched", stringCount: number | null = null, staffCount: number | null = null) => ({ kind, stringCount, staffCount });

describe("a phrase fits a part", () => {
  test("of the same kind only", () => {
    expect(fitsPart(phrase("percussion"), DRUMS)).toBe(true);
    expect(fitsPart(phrase("percussion"), GUITAR)).toBe(false);
    expect(fitsPart(phrase("fretted", 6), DRUMS)).toBe(false);
    expect(fitsPart(phrase("pitched", null, 1), GUITAR)).toBe(false);
  });

  test("fretted, on no more strings than the part has", () => {
    expect(fitsPart(phrase("fretted", 6), GUITAR)).toBe(true);
    expect(fitsPart(phrase("fretted", 4), GUITAR)).toBe(true);
    expect(fitsPart(phrase("fretted", 4), BASS)).toBe(true);
    expect(fitsPart(phrase("fretted", 6), BASS)).toBe(false);
    expect(fitsPart(phrase("fretted", 7), GUITAR)).toBe(false);
  });

  test("pitched, on no more staves than the part has", () => {
    expect(fitsPart(phrase("pitched", null, 1), PIANO)).toBe(true);
    expect(fitsPart(phrase("pitched", null, 2), PIANO)).toBe(true);
    expect(fitsPart(phrase("pitched", null, 1), MELODY)).toBe(true);
    expect(fitsPart(phrase("pitched", null, 2), MELODY)).toBe(false);
  });
});

test("the sidebar lists the phrases that fit, or all of them when asked, or when there is no part", () => {
  const phrases = [phrase("fretted", 6), phrase("fretted", 4), phrase("percussion"), phrase("pitched", null, 2)];
  expect(phrasesShown(phrases, BASS, false)).toEqual([phrases[1]]);
  expect(phrasesShown(phrases, GUITAR, false)).toEqual([phrases[0], phrases[1]]);
  expect(phrasesShown(phrases, BASS, true)).toEqual(phrases);
  expect(phrasesShown(phrases, undefined, false)).toEqual(phrases);
});

describe("a phrase dragged over the score", () => {
  const score = {
    bars: ["b1", "b2", "b3", "b4"].map((id) => ({ id, timeSig: { numerator: 4, denominator: 4 } })),
    parts: [
      { id: "guitar", ...GUITAR },
      { id: "drums", ...DRUMS },
    ],
  } as unknown as ScoreJSON;
  const at = (partId: string, barId: string): Cursor => ({ partId, barId, voice: "0:0", beatId: null, at: "after", line: 1 });

  test("goes on the bar under the pointer, over as many bars as it has", () => {
    expect(dropSpotOf(score, at("guitar", "b2"), { kind: "fretted", barCount: 2 })).toEqual({ partId: "guitar", barId: "b2", refused: false, first: "b2", last: "b3" });
  });

  test("takes the bars to the end of the score when it has more: the rest are appended on the drop", () => {
    expect(dropSpotOf(score, at("guitar", "b3"), { kind: "fretted", barCount: 5 })).toMatchObject({ first: "b3", last: "b4", refused: false });
  });

  test("cannot be dropped on a part of another kind: only the bar under the pointer is marked so", () => {
    expect(dropSpotOf(score, at("drums", "b1"), { kind: "fretted", barCount: 2 })).toEqual({ partId: "drums", barId: "b1", refused: true, first: "b1", last: "b1" });
  });

  test("goes nowhere outside any bar, or on a part or bar the score no longer has", () => {
    expect(dropSpotOf(score, null, { kind: "fretted", barCount: 2 })).toBeNull();
    expect(dropSpotOf(score, at("gone", "b1"), { kind: "fretted", barCount: 2 })).toBeNull();
    expect(dropSpotOf(score, at("guitar", "gone"), { kind: "fretted", barCount: 2 })).toBeNull();
  });
});

test("a phrase's content is asked for once per revision, and again after it could not be had", async () => {
  const asked: string[] = [];
  let failing = true;
  const contents = phraseContents(async (id) => {
    asked.push(id);
    if (failing) throw new Error("offline");
    return blankFragment(PART_PRESETS.guitar6);
  });
  await expect(contents.of({ id: "a", revision: 1 })).rejects.toThrow("offline");
  failing = false;
  await contents.of({ id: "a", revision: 1 });
  await contents.of({ id: "a", revision: 1 });
  await contents.of({ id: "a", revision: 2 });
  expect(asked).toEqual(["a", "a", "a"]);
});
