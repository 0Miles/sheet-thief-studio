// Which MIDI channels each part plays on (docs/spec/playback.md, section 5): a pure function of
// the kinds of the parts, in score order.
import { MAX_NON_PERCUSSION_PARTS, type PartKind } from "@studio/score-model";
import { expect, test } from "vitest";

import { channelsOf, PERCUSSION_CHANNEL } from "../src/channels";

const pitched = (count: number): PartKind[] => Array.from({ length: count }, () => "pitched");
const primaries = (kinds: PartKind[]) => channelsOf(kinds).map((channels) => channels.primary);
const secondaries = (kinds: PartKind[]) => channelsOf(kinds).map((channels) => channels.secondary);

test("no parts have no channels", () => {
  expect(channelsOf([])).toEqual([]);
});

test("drums play on channel 9 alone, however many", () => {
  expect(PERCUSSION_CHANNEL).toBe(9);
  expect(channelsOf(["percussion"])).toEqual([{ primary: 9, secondary: 9 }]);
  expect(channelsOf(Array.from({ length: 17 }, () => "percussion"))).toEqual(Array.from({ length: 17 }, () => ({ primary: 9, secondary: 9 })));
});

test("three parts and drums: primaries 0, 1, 2, secondaries 3, 4, 5, drums 9 (the example of the spec)", () => {
  expect(channelsOf(["fretted", "pitched", "fretted", "percussion"])).toEqual([
    { primary: 0, secondary: 3 },
    { primary: 1, secondary: 4 },
    { primary: 2, secondary: 5 },
    { primary: 9, secondary: 9 },
  ]);
});

test("drums anywhere in the order take no channel from the other parts", () => {
  expect(channelsOf(["percussion", "fretted", "percussion", "pitched"])).toEqual([
    { primary: 9, secondary: 9 },
    { primary: 0, secondary: 2 },
    { primary: 9, secondary: 9 },
    { primary: 1, secondary: 3 },
  ]);
});

test("fifteen parts and drums: a primary each, none 9, and each secondary is its primary", () => {
  const kinds: PartKind[] = [...pitched(7), "percussion", ...pitched(8)];
  const channels = channelsOf(kinds);
  const own = channels.filter((_, index) => kinds[index] !== "percussion");
  expect(own.map((channel) => channel.primary)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]);
  expect(own.every((channel) => channel.secondary === channel.primary)).toBe(true);
  expect(channels[7]).toEqual({ primary: 9, secondary: 9 });
});

test("the channels left over go as secondaries in part order; the parts after them use their primary", () => {
  // Eight parts take 0-7; 8 and 10-15 are left, seven channels for the first seven parts.
  expect(primaries(pitched(8))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  expect(secondaries(pitched(8))).toEqual([8, 10, 11, 12, 13, 14, 15, 7]);
  // Nine parts take 0-8; 10-15 are left: a secondary of their own for the first six.
  expect(secondaries(pitched(9))).toEqual([10, 11, 12, 13, 14, 15, 6, 7, 8]);
});

test("no two parts share a channel while at most fifteen parts are not drums", () => {
  for (let count = 1; count <= MAX_NON_PERCUSSION_PARTS; count++) {
    const used = channelsOf(pitched(count)).flatMap(({ primary, secondary }) => (primary === secondary ? [primary] : [primary, secondary]));
    expect(new Set(used).size).toBe(used.length);
    expect(used).not.toContain(PERCUSSION_CHANNEL);
    expect(used.every((channel) => channel >= 0 && channel <= 15)).toBe(true);
  }
});

test("past fifteen parts that are not drums, the parts over share the channel of the fifteenth", () => {
  // Two members adding parts at once can go over the limit: no command can stop it.
  const kinds: PartKind[] = [...pitched(16), "percussion", "fretted"];
  const channels = channelsOf(kinds);
  expect(channels.slice(0, 15).map((channel) => channel.primary)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15]);
  expect(channels.slice(0, 15).every((channel) => channel.secondary === channel.primary)).toBe(true);
  expect(channels[15]).toEqual({ primary: 15, secondary: 15 });
  expect(channels[16]).toEqual({ primary: 9, secondary: 9 });
  expect(channels[17]).toEqual({ primary: 15, secondary: 15 });
});
