// Where alphaTab draws a dynamic (docs/spec/schema.md, section 8): only where the score writes one.
import * as alphaTab from "@coderline/alphatab";
import { addPart, changeBeatAt, createScore, type Cursor, cursorAt, docToJson, dynamicCycle, insertBars, insertBeat, type ScoreJSON, setFret } from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { projectScore } from "../src/projection";

/** alphaTab's dynamics glyphs (`DynamicsGlyph`) as its SVG writes them: the SMuFL code points 58656 to 58685, as entities. */
const DYNAMIC_GLYPHS = /&#(?:5865[6-9]|586[67]\d|5868[0-5]);/g;

/** The SVG alphaTab draws for a score, laid out and painted without a browser, every piece of it. */
function svgOf(score: ScoreJSON): string {
  const settings = new alphaTab.Settings();
  settings.core.engine = "svg";
  settings.display.layoutMode = alphaTab.LayoutMode.Page;
  const renderer = new alphaTab.rendering.ScoreRenderer(settings);
  renderer.width = 1200;
  const pieces: string[] = [];
  renderer.partialLayoutFinished.on((result) => renderer.renderResult(result.id));
  renderer.partialRenderFinished.on((result) => {
    if (typeof result.renderResult === "string") pieces.push(result.renderResult);
  });
  renderer.renderScore(projectScore(score, settings).score, score.parts.map((_, index) => index));
  return pieces.join("");
}

/** How many dynamics alphaTab draws. */
const dynamicsDrawn = (svg: string) => svg.match(DYNAMIC_GLYPHS)?.length ?? 0;

/** A guitar over two bars of four quarters, a fret on each; `marked` gives the beats their dynamics. */
function guitar(marked: (doc: Y.Doc, beats: Cursor[]) => void = () => {}): ScoreJSON {
  const doc = new Y.Doc();
  createScore(doc, "Dynamics");
  const barIds = insertBars(doc, { after: null, count: 2 });
  const partId = addPart(doc, { name: "Guitar", kind: "fretted" });
  const beats = barIds.flatMap((barId) => {
    let cursor = cursorAt(doc, partId, barId);
    return [0, 1, 2, 3].map(() => {
      cursor = insertBeat(doc, { ...cursor, at: "after" }, { value: 4 });
      setFret(doc, cursor, 3);
      return cursor;
    });
  });
  marked(doc, beats);
  return docToJson(doc);
}

test("a score that writes no dynamic draws none: not even alphaTab's own f on its first note", () => {
  const svg = svgOf(guitar());
  expect(svg.length).toBeGreaterThan(0);
  expect(dynamicsDrawn(svg)).toBe(0);
});

test("a pp written on the second beat is drawn once, though it holds over the beats after it, into the next bar", () => {
  expect(dynamicsDrawn(svgOf(guitar((doc, beats) => changeBeatAt(doc, beats[1]!, dynamicCycle))))).toBe(1);
});
