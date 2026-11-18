// Where alphaTab draws a dynamic (docs/spec/schema.md, section 8): only where the score writes one.
import * as alphaTab from "@coderline/alphatab";
import { addPart, changeBeatAt, createScore, type Cursor, cursorAt, docToJson, DYNAMICS, dynamicCycle, insertBars, insertBeat, type ScoreJSON, setFret } from "@studio/score-model";
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

/** The code point of each dynamic's glyph (alphaTab's `DynamicsGlyph`). */
const GLYPHS = new Map([
  ["&#58667;", "pp"],
  ["&#58656;", "p"],
  ["&#58668;", "mp"],
  ["&#58669;", "mf"],
  ["&#58658;", "f"],
  ["&#58671;", "ff"],
]);

/** Which dynamics alphaTab draws for a score, by name, in alphabetical order. */
const namesDrawn = (score: ScoreJSON) => (svgOf(score).match(DYNAMIC_GLYPHS) ?? []).map((glyph) => GLYPHS.get(glyph) ?? glyph).sort();

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

/**
 * A score of bars of four quarters, one guitar for each entry of `parts`: its voices ("staff:voice")
 * to their bars, each bar its beats, `x` a fret and `-` a rest, after the dynamic written on it, if
 * any ("pp-" is a rest marked pp). A bar of fewer beats is filled with rests by the projection.
 */
function written(parts: Record<string, string[]>[]): ScoreJSON {
  const doc = new Y.Doc();
  createScore(doc, "Rests");
  const barIds = insertBars(doc, { after: null, count: Math.max(...parts.flatMap((voices) => Object.values(voices).map((bars) => bars.length))) });
  parts.forEach((voices, index) => {
    const partId = addPart(doc, { name: `Guitar ${index + 1}`, kind: "fretted" });
    for (const [voice, bars] of Object.entries(voices)) {
      bars.forEach((bar, barIndex) => {
        let cursor: Cursor = { ...cursorAt(doc, partId, barIds[barIndex]!), voice, beatId: null, at: "after" };
        for (const token of bar.split(" ").filter(Boolean)) {
          const [, dynamic, kind] = /^([a-z]*)([x-])$/.exec(token)!;
          cursor = insertBeat(doc, { ...cursor, at: "after" }, { value: 4 });
          if (kind === "x") setFret(doc, cursor, 3);
          for (let step = (DYNAMICS as readonly string[]).indexOf(dynamic!); step >= 0; step--) changeBeatAt(doc, cursor, dynamicCycle);
        }
      });
    }
  });
  return docToJson(doc);
}

test("a dynamic written on a rest is drawn on the next beat that is not one, in its bar (#97)", () => {
  expect(namesDrawn(written([{ "0:0": ["pp- - x x"] }]))).toEqual(["pp"]);
});

test("a dynamic written on a rest at the end of a bar is drawn on the next beat that is not a rest, in the bars after (#97)", () => {
  expect(namesDrawn(written([{ "0:0": ["x x x pp-", "- x x x"] }]))).toEqual(["pp"]);
  // The rests that fill the bar, and a bar with nothing written, are rests as well.
  expect(namesDrawn(written([{ "0:0": ["x mf-", "", "- - x"] }]))).toEqual(["mf"]);
});

test("a dynamic on a rest gives way to one written on the beat it would be drawn on, or on a rest before it: one is drawn, the last (#97)", () => {
  expect(namesDrawn(written([{ "0:0": ["pp- - ffx x"] }]))).toEqual(["ff"]);
  expect(namesDrawn(written([{ "0:0": ["x x pp- -", "ffx x x x"] }]))).toEqual(["ff"]);
  expect(namesDrawn(written([{ "0:0": ["pp- mf- x x"] }]))).toEqual(["mf"]);
  // A dynamic on a rest after a drawn one is drawn too.
  expect(namesDrawn(written([{ "0:0": ["ppx - f- x"] }]))).toEqual(["f", "pp"]);
});

test("a dynamic on a rest with no beat but rests after it, to the end of the score, is not drawn (#97)", () => {
  expect(namesDrawn(written([{ "0:0": ["x x pp- -", "- - - -"] }]))).toEqual([]);
  expect(namesDrawn(written([{ "0:0": ["x x x pp-"] }]))).toEqual([]);
});

test("a dynamic on a rest is drawn in its own voice and part only (#97)", () => {
  // Nothing after it in its voice, though the other voice, or the other part, has notes there.
  expect(namesDrawn(written([{ "0:0": ["pp- - - -", "- - - -"], "0:1": ["x x x x", "x x x x"] }]))).toEqual([]);
  expect(namesDrawn(written([{ "0:0": ["x x x x"], "0:1": ["pp- - - -"] }]))).toEqual([]);
  expect(namesDrawn(written([{ "0:0": ["pp- - - -", "- - - -"] }, { "0:0": ["x x x x", "x x x x"] }]))).toEqual([]);
  // Each voice and each part draws its own, where its own notes come.
  expect(namesDrawn(written([{ "0:0": ["pp- x x x"], "0:1": ["- ff- - -", "x"] }]))).toEqual(["ff", "pp"]);
  expect(namesDrawn(written([{ "0:0": ["x x x p-", "x"] }, { "0:0": ["mf- - - -", "- x"] }]))).toEqual(["mf", "p"]);
});
