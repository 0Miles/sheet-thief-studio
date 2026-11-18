// Saving bars of a score as a phrase (#55; docs/spec/phrases.md, section 3): only a range of bars
// can be, what of them could not be read is told, the name it is offered under, and what a
// refused save says.
import { phraseLimits } from "@studio/contracts";
import { blankFragment, type InvalidContentFlag, PART_PRESETS, type ScoreJSON, type Selection } from "@studio/score-model";
import { afterEach, expect, test, vi } from "vitest";

import { ApiError } from "../src/api";
import { barsToSave, defaultPhraseName, saveAsPhrase, saveRefusal } from "../src/savePhrase";
import { strings } from "../src/strings";

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
const unread = (place: Omit<InvalidContentFlag, "kind" | "what">): InvalidContentFlag => ({ kind: "invalidContent", what: "beat", ...place });

afterEach(() => {
  vi.unstubAllGlobals();
});

test("a range of bars, chosen backwards too, is saved as its bars with their numbers in the score", () => {
  expect(barsToSave(SCORE, bars("b3", "b2"), [])).toEqual({
    first: 2,
    last: 3,
    skipped: false,
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
  expect(barsToSave(SCORE, { kind: "beats", partId: "p1", barId: "b2", voice: "0:0", anchorBeatId: "x1", focusBeatId: "x1" } as unknown as Selection, [])).toBeNull();
  expect(barsToSave(SCORE, null, [])).toBeNull();
  expect(barsToSave(SCORE, { kind: "bars", partId: "gone", anchorBarId: "b1", focusBarId: "b2" }, [])).toBeNull();
  expect(barsToSave(SCORE, bars("b1", "gone"), [])).toBeNull();
});

test("what could not be read in those bars of that part, or of those bars themselves, is told as left out; elsewhere it is not", () => {
  expect(barsToSave(SCORE, bars("b2", "b3"), [unread({ partId: "p1", barId: "b3", voice: "0:0" })])?.skipped).toBe(true);
  expect(barsToSave(SCORE, bars("b2", "b3"), [{ kind: "invalidContent", barId: "b2", what: "bar.timeSig" }])?.skipped).toBe(true);
  expect(barsToSave(SCORE, bars("b2", "b3"), [unread({ partId: "p1", barId: "b1" }), unread({ partId: "p2", barId: "b2" }), { kind: "invalidContent", what: "meta.title" }])?.skipped).toBe(false);
});

test("the name offered is the score's title and the bars, one bar by its number alone, an untitled score as 「未命名」", () => {
  expect(defaultPhraseName("練習曲", 2, 3)).toBe("練習曲 第 2–3 小節");
  expect(defaultPhraseName("練習曲", 5, 5)).toBe("練習曲 第 5 小節");
  expect(defaultPhraseName("", 1, 4)).toBe("未命名 第 1–4 小節");
  expect(defaultPhraseName("  ", 1, 4)).toBe("未命名 第 1–4 小節");
});

test("a title too long for a phrase's name is cut short a whole character at a time, an emoji of several never split, so that the bars still fit", () => {
  // A family: three people joined by two zero-width joiners, 8 UTF-16 code units.
  const family = "👨‍👩‍👧";
  const name = defaultPhraseName(family.repeat(20), 2, 3);
  expect(name.length).toBeLessThanOrEqual(phraseLimits.name.max);
  // 100 code units: the 9 of the bars, and 11 families (88); a man and a joiner of a 12th would
  // still fit in the 3 left, splitting it.
  expect(name).toBe(`${family.repeat(11)} 第 2–3 小節`);
  expect(defaultPhraseName("𝄞".repeat(80), 12, 34)).toBe(`${"𝄞".repeat(44)} 第 12–34 小節`);
});

test("any save refused as too large says the phrase is too large: the server's own limit of a request's size too", () => {
  const tooLarge = strings.errors.phrase_too_large;
  expect(saveRefusal(new ApiError(413, "payload_too_large"))).toBe(tooLarge);
  expect(saveRefusal(new ApiError(413, "phrase_too_large"))).toBe(tooLarge);
  expect(saveRefusal(new ApiError(429, "rate_limited"))).toBe(strings.errors.rate_limited);
  expect(saveRefusal(new TypeError("Failed to fetch"))).toBe(strings.unknownError);
});

test("saving posts the name and the fragment to the library, giving the new phrase's id; a body too large for the server is refused as a phrase too large", async () => {
  const fragment = blankFragment(PART_PRESETS.guitar6);
  const answer = { status: 201, body: { id: "new", revision: 1 } as object };
  const fetch = vi.fn(async () => new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  await expect(saveAsPhrase("樂句", fragment)).resolves.toBe("new");
  expect(fetch).toHaveBeenCalledWith("/api/phrases", expect.objectContaining({ method: "POST", body: JSON.stringify({ name: "樂句", fragment }) }));

  Object.assign(answer, { status: 413, body: { code: "payload_too_large" } });
  const refused = await saveAsPhrase("樂句", fragment).catch((failure: unknown) => failure);
  expect(saveRefusal(refused)).toBe(strings.errors.phrase_too_large);
});
