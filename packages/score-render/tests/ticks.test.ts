// Which bar is played at a tick, and at which tick a bar starts: read from the tick lookup alphaTab
// builds with the sound of a score (docs/spec/playback.md, section 4).
import * as alphaTab from "@coderline/alphatab";
import { addPart, createScore, docToJson, insertBars } from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { projectScore } from "../src/projection";
import { barAtTick, barStartTick } from "../src/ticks";

const settings = new alphaTab.Settings();
/** A bar of 4/4, in ticks: 960 to a quarter note. */
const FOUR_FOUR = 4 * 960;

/** The tick lookup of a score of bars of these time signatures (numerators over 4), as alphaTab makes it with the sound. */
function lookupOf(numerators: number[]): alphaTab.midi.MidiTickLookup {
  const doc = new Y.Doc();
  createScore(doc, "Ticks");
  let after: string | null = null;
  for (const numerator of numerators) [after] = insertBars(doc, { after, count: 1, timeSig: { numerator, denominator: 4 } });
  addPart(doc, { name: "Guitar", kind: "fretted" });
  const { score } = projectScore(docToJson(doc), settings);
  const generator = new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(new alphaTab.midi.MidiFile()));
  generator.generate();
  return generator.tickLookup;
}

test("each bar of 4/4 starts four quarter notes after the one before", () => {
  const lookup = lookupOf([4, 4, 4, 4, 4, 4, 4, 4]);
  expect([0, 1, 2, 3, 4, 5, 6, 7].map((index) => barStartTick(lookup, index))).toEqual([0, 3840, 7680, 11520, 15360, 19200, 23040, 26880]);
});

test("a bar of 3/4 is three quarter notes long", () => {
  const lookup = lookupOf([4, 3, 4]);
  expect([0, 1, 2].map((index) => barStartTick(lookup, index))).toEqual([0, 3840, 6720]);
});

test("the bar played at a tick, and how far into it", () => {
  const lookup = lookupOf([4, 3, 4]);
  expect(barAtTick(lookup, 0)).toEqual({ index: 0, offset: 0 });
  expect(barAtTick(lookup, FOUR_FOUR - 1)).toEqual({ index: 0, offset: FOUR_FOUR - 1 });
  expect(barAtTick(lookup, FOUR_FOUR)).toEqual({ index: 1, offset: 0 });
  expect(barAtTick(lookup, 6720 + 100)).toEqual({ index: 2, offset: 100 });
});

test("past the end, the last bar; a bar that is not in the score has no start", () => {
  const lookup = lookupOf([4, 4]);
  expect(barAtTick(lookup, 3 * FOUR_FOUR)).toEqual({ index: 1, offset: 2 * FOUR_FOUR });
  expect(barStartTick(lookup, 2)).toBeNull();
});
