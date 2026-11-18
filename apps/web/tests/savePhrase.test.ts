// Saving bars of a score as a phrase (#55; docs/spec/phrases.md, section 3): only a range of bars
// can be, and the name it is offered under.
import { phraseLimits } from "@studio/contracts";
import { type ScoreJSON, type Selection } from "@studio/score-model";
import { expect, test } from "vitest";

import { barsToSave, defaultPhraseName } from "../src/savePhrase";

/** A score of one 6-string part and three bars, a beat in the second and the third. */
const SCORE = {
  schemaVersion: 1,
  title: "練習曲",
  bars: [
    { id: "b1", timeSig: { numerator: 4, denominator: 4 } },
    { id: "b2", timeSig: { numerator: 3, denominator: 4 } },
    { id: "b3", timeSig: { numerator: 4, denominator: 4 }, tempo: 90 },
  ],
  parts: [
    {
      id: "p1",
      name: "吉他",
      kind: "fretted",
      tuning: [64, 59, 55, 50, 45, 40],
      capo: 2,
      program: 25,
      staves: [{}],
      content: {
        b2: { "0:0": [{ id: "x1", value: 4, dots: 0, notes: { s1: { fret: 3 } } }] },
        b3: { "0:0": [{ id: "x2", value: 4, dots: 0, notes: { s2: { fret: 5 } } }] },
      },
    },
  ],
} as unknown as ScoreJSON;

const bars = (anchorBarId: string, focusBarId: string): Selection => ({ kind: "bars", partId: "p1", anchorBarId, focusBarId });

test("a range of bars, chosen backwards too, is saved as its bars with their numbers in the score", () => {
  expect(barsToSave(SCORE, bars("b3", "b2"))).toEqual({
    first: 2,
    last: 3,
    fragment: {
      kind: "fretted",
      tuning: [64, 59, 55, 50, 45, 40],
      bars: [
        { timeSig: { numerator: 3, denominator: 4 }, voices: { "0:0": [{ value: 4, dots: 0, notes: { s1: { fret: 3 } } }] } },
        { timeSig: { numerator: 4, denominator: 4 }, voices: { "0:0": [{ value: 4, dots: 0, notes: { s2: { fret: 5 } } }] } },
      ],
    },
  });
});

test("nothing is saved from a range of beats, no selection, or a range whose part or bars are gone", () => {
  expect(barsToSave(SCORE, { kind: "beats", partId: "p1", barId: "b2", voice: "0:0", anchorBeatId: "x1", focusBeatId: "x1" } as unknown as Selection)).toBeNull();
  expect(barsToSave(SCORE, null)).toBeNull();
  expect(barsToSave(SCORE, { kind: "bars", partId: "gone", anchorBarId: "b1", focusBarId: "b2" })).toBeNull();
  expect(barsToSave(SCORE, bars("b1", "gone"))).toBeNull();
});

test("the name offered is the score's title and the bars, one bar by its number alone, an untitled score as 「未命名」", () => {
  expect(defaultPhraseName("練習曲", 2, 3)).toBe("練習曲 第 2–3 小節");
  expect(defaultPhraseName("練習曲", 5, 5)).toBe("練習曲 第 5 小節");
  expect(defaultPhraseName("", 1, 4)).toBe("未命名 第 1–4 小節");
  expect(defaultPhraseName("  ", 1, 4)).toBe("未命名 第 1–4 小節");
});

test("a title too long for a phrase's name is cut short, never a character split in two, so that the bars still fit", () => {
  const name = defaultPhraseName("𝄞".repeat(80), 12, 34);
  expect(name.length).toBeLessThanOrEqual(phraseLimits.name.max);
  expect(name.endsWith(" 第 12–34 小節")).toBe(true);
  // 100 UTF-16 code units: the 11 of the bars, and 44 clefs of two each (a 45th would split).
  expect(name).toBe(`${"𝄞".repeat(44)} 第 12–34 小節`);
});
