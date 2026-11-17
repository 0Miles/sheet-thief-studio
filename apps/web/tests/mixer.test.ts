// Each member's own playback settings, kept in this browser (docs/spec/playback.md, section 1).
import { beforeEach, expect, test } from "vitest";

import { loadMix, loadPlayback, mixerKey, PLAYBACK_KEY, saveMix, savePlayback, SPEEDS } from "../src/mixer";

beforeEach(() => localStorage.clear());

test("speeds go from 25% to 150%, every 5%", () => {
  expect(SPEEDS[0]).toBe(0.25);
  expect(SPEEDS.at(-1)).toBe(1.5);
  expect(SPEEDS).toHaveLength(26);
  expect(SPEEDS).toContain(0.85);
});

test("nothing stored: every part as the score has it, at the score's tempo; metronome and count-in off, (a)", () => {
  expect(loadMix("s1")).toEqual({ parts: new Map(), speed: 1 });
  expect(loadPlayback()).toEqual({ metronome: false, countIn: false, whilePlaying: "a" });
});

test("a score's mix, stored by part id, is read back for that score only", () => {
  saveMix("s1", {
    parts: new Map([
      ["p1", { mute: true, solo: false, volume: 1 }],
      ["p2", { mute: false, solo: false, volume: 1 }],
      ["p3", { mute: false, solo: true, volume: 0.35 }],
    ]),
    speed: 0.75,
  });
  // A part as the score has it is not written.
  expect(Object.keys((JSON.parse(localStorage.getItem(mixerKey("s1"))!) as { parts: object }).parts)).toEqual(["p1", "p3"]);
  expect(loadMix("s1")).toEqual({
    parts: new Map([
      ["p1", { mute: true, solo: false, volume: 1 }],
      ["p3", { mute: false, solo: true, volume: 0.35 }],
    ]),
    speed: 0.75,
  });
  expect(loadMix("s2")).toEqual({ parts: new Map(), speed: 1 });
});

test("what cannot be read is left as the score has it", () => {
  localStorage.setItem(mixerKey("s1"), JSON.stringify({ parts: { p1: { mute: "yes", volume: 7 }, p2: 3, __proto__: { mute: true } }, speed: 0.33 }));
  const mix = loadMix("s1");
  expect(mix.speed).toBe(1);
  expect(mix.parts.get("p1")).toEqual({ mute: false, solo: false, volume: 1 });
  expect(mix.parts.has("p2")).toBe(false);
  localStorage.setItem(mixerKey("s1"), "{not json");
  expect(loadMix("s1")).toEqual({ parts: new Map(), speed: 1 });
  localStorage.setItem(PLAYBACK_KEY, JSON.stringify({ metronome: 1, countIn: true, whilePlaying: "c" }));
  expect(loadPlayback()).toEqual({ metronome: false, countIn: true, whilePlaying: "a" });
});

test("a part id named __proto__ is a part like any other", () => {
  localStorage.setItem(mixerKey("s1"), '{"parts":{"__proto__":{"mute":true}},"speed":1}');
  expect(loadMix("s1").parts.get("__proto__")).toEqual({ mute: true, solo: false, volume: 1 });
});

test("the settings of every score are stored once, for all of them", () => {
  savePlayback({ metronome: true, countIn: true, whilePlaying: "b" });
  expect(loadPlayback()).toEqual({ metronome: true, countIn: true, whilePlaying: "b" });
});
