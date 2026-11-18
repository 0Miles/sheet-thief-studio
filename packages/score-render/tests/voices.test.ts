// The second voice of a staff (#45): drums written hands and feet apart. A bar whose second voice
// has beats draws it as alphaTab's second voice; one whose second voice is empty draws nothing
// of it, not a rest in every bar (docs/spec/schema.md, sections 1.1 and 8).
import * as alphaTab from "@coderline/alphatab";
import { addPart, createScore, type Cursor, cursorAt, docToJson, DRUM_PIECES, insertBars, insertBeat, type NoteValue, type ScoreJSON, setNote } from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { cursorRect, noteHeads, type PartShape, type StaffMetrics } from "../src/geometry";
import { beatIdOf, beatOf, projectScore, replaceBars } from "../src/projection";

const settings = new alphaTab.Settings();
const { Duration } = alphaTab.model;

const KICK = `p${DRUM_PIECES.kick.id}`;
const HI_HAT = `p${DRUM_PIECES.hiHatClosed.id}`;

/** Two bars of drums: four hi-hats in the first voice of each; `feet` the kicks of the second voice of the first bar. */
function drums(feet: NoteValue[] = []) {
  const doc = new Y.Doc();
  createScore(doc, "Drums");
  const barIds = insertBars(doc, { after: null, count: 2 });
  const partId = addPart(doc, { name: "Drums", kind: "percussion" });
  const write = (barId: string, voice: string, values: NoteValue[], key: string): Cursor[] => {
    let cursor: Cursor = { ...cursorAt(doc, partId, barId), voice, beatId: null, at: "after" };
    return values.map((value) => {
      cursor = insertBeat(doc, { ...cursor, at: "after" }, { value });
      setNote(doc, cursor, key, {});
      return cursor;
    });
  };
  for (const barId of barIds) write(barId, "0:0", [4, 4, 4, 4], HI_HAT);
  const kicks = write(barIds[0]!, "0:1", feet, KICK);
  return { doc, barIds, partId, kicks, write };
}

/** What each voice of a bar of the drums holds: a note value and the pieces, `rest` or `empty` (not drawn). */
function voicesOf(score: alphaTab.model.Score, bar: number) {
  return score.tracks[0]!.staves[0]!.bars[bar]!.voices.map((voice) =>
    voice.beats.map((beat) => (beat.isEmpty ? "empty" : `${beat.duration}:${beat.isRest ? "rest" : beat.notes.map((note) => note.percussionArticulation).join("+")}`)),
  );
}

test("drums without a second voice have one voice in every bar", () => {
  const { doc } = drums();
  const { score } = projectScore(docToJson(doc), settings);
  expect(voicesOf(score, 0)).toEqual([["4:42", "4:42", "4:42", "4:42"]]);
  expect(voicesOf(score, 1)).toHaveLength(1);
});

test("a second voice with beats becomes alphaTab's second voice, completed with rests; where it is empty it is not drawn, not even as a rest", () => {
  const { doc, kicks } = drums([4, 4]);
  const json = docToJson(doc);
  const projection = projectScore(json, settings);
  expect(voicesOf(projection.score, 0)).toEqual([
    ["4:42", "4:42", "4:42", "4:42"],
    ["4:36", "4:36", `${Duration.Half}:rest`],
  ]);
  expect(voicesOf(projection.score, 1)).toEqual([["4:42", "4:42", "4:42", "4:42"], ["empty"]]);
  // The beats of the second voice have their places, and are found back from alphaTab's.
  const second = kicks[1]!.beatId!;
  expect(projection.addresses.get(second)).toEqual({ track: 0, staff: 0, bar: 0, voice: 1, beat: 1 });
  expect(beatIdOf(projection, beatOf(projection, second)!)).toBe(second);
});

test("the first beat in the second voice adds a voice: the whole score is projected again; later beats replace their bar like any other", () => {
  const { doc, barIds, write } = drums();
  const projection = projectScore(docToJson(doc), settings);
  write(barIds[1]!, "0:1", [2], KICK);
  expect(replaceBars(projection, docToJson(doc), [barIds[1]!], settings)).toBeNull();

  const again = projectScore(docToJson(doc), settings);
  const feet = docToJson(doc).parts[0]!.content[barIds[1]!]!["0:1"]!;
  setNote(doc, { ...cursorAt(doc, again.partIds[0]!, barIds[1]!), voice: "0:1", beatId: feet[0]!.id, at: "on" }, HI_HAT, {});
  const json = docToJson(doc);
  expect(replaceBars(again, json, [barIds[1]!], settings)).toBe(1);
  const whole = projectScore(json, settings);
  for (const bar of [0, 1]) expect(voicesOf(again.score, bar)).toEqual(voicesOf(whole.score, bar));
  expect(voicesOf(again.score, 1)[1]).toEqual([`${Duration.Half}:36+42`, `${Duration.Half}:rest`]);
});

/** alphaTab's rest glyphs as its SVG writes them: the SMuFL code points 58592 (U+E4E0) to 58607, as entities. */
const REST_GLYPHS = /&#(?:5859[2-9]|5860[0-7]);/g;

/** How many rests alphaTab draws for a score, laid out and painted without a browser. */
function restsDrawn(score: ScoreJSON): number {
  const svgSettings = new alphaTab.Settings();
  svgSettings.core.engine = "svg";
  svgSettings.display.layoutMode = alphaTab.LayoutMode.Page;
  const renderer = new alphaTab.rendering.ScoreRenderer(svgSettings);
  renderer.width = 1200;
  const pieces: string[] = [];
  renderer.partialLayoutFinished.on((result) => renderer.renderResult(result.id));
  renderer.partialRenderFinished.on((result) => {
    if (typeof result.renderResult === "string") pieces.push(result.renderResult);
  });
  renderer.renderScore(projectScore(score, svgSettings).score, [0]);
  return pieces.join("").match(REST_GLYPHS)?.length ?? 0;
}

test("drawn, the bars whose second voice is empty have no rests; the one with kicks has only the rest that completes it", () => {
  expect(restsDrawn(docToJson(drums().doc))).toBe(0);
  expect(restsDrawn(docToJson(drums([4, 4]).doc))).toBe(1);
});

test("the cursor on a beat of the second voice is centred on its note heads, within a pixel, as on the first voice (S3's way, #45)", () => {
  const doc = new Y.Doc();
  createScore(doc, "Drums");
  const barIds = insertBars(doc, { after: null, count: 2 });
  const partId = addPart(doc, { name: "Drums", kind: "percussion" });
  const beatsIn = (barId: string, voice: string, values: [NoteValue, string[]][]): Cursor[] => {
    let cursor: Cursor = { ...cursorAt(doc, partId, barId), voice, beatId: null, at: "after" };
    return values.map(([value, keys]) => {
      cursor = insertBeat(doc, { ...cursor, at: "after" }, { value });
      for (const key of keys) setNote(doc, cursor, key, {});
      return cursor;
    });
  };
  const SNARE = `p${DRUM_PIECES.snare.id}`;
  const PEDAL = `p${DRUM_PIECES.hiHatPedal.id}`;
  // Hands: eighths on the hi-hat, the snare on 2 and 4. Feet: kicks, the pedal hi-hat, an eighth off the beat.
  const hands = barIds.flatMap((barId) => beatsIn(barId, "0:0", [0, 1, 2, 3, 4, 5, 6, 7].map((at) => [8, at % 4 === 2 ? [HI_HAT, SNARE] : [HI_HAT]])));
  const feet = [
    ...beatsIn(barIds[0]!, "0:1", [[4, [KICK]], [8, [PEDAL]], [8, [KICK]], [2, [KICK]]]),
    ...beatsIn(barIds[1]!, "0:1", [[4, [KICK, PEDAL]]]),
  ];
  const json = docToJson(doc);
  const svgSettings = new alphaTab.Settings();
  svgSettings.core.engine = "svg";
  svgSettings.core.includeNoteBounds = true;
  svgSettings.display.layoutMode = alphaTab.LayoutMode.Page;
  const projection = projectScore(json, svgSettings);
  const renderer = new alphaTab.rendering.ScoreRenderer(svgSettings);
  renderer.width = 1200;
  renderer.renderScore(projection.score, [0]);
  const engraving = svgSettings.display.resources.engravingSettings;
  const metrics: StaffMetrics = { staffSpace: engraving.oneStaffSpace, tabLineSpacing: engraving.tabLineSpacing, lineThickness: engraving.staffLineThickness };
  const parts = new Map<string, PartShape>([[partId, { kind: "percussion", strings: 0 }]]);
  const lookup = renderer.boundsLookup!;
  for (const [index, beat] of [...feet, ...hands].entries()) {
    const heads = noteHeads(lookup, projection, parts, beat);
    expect(heads.length, `beat ${index}`).toBeGreaterThan(0);
    const rect = cursorRect(lookup, projection, parts, beat, metrics)!;
    const centre = rect.x + rect.width / 2;
    for (const head of heads) expect(Math.abs(head.rect.x + head.rect.width / 2 - centre), `beat ${index}, ${head.key}`).toBeLessThanOrEqual(1);
  }
});
