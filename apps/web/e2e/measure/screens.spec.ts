// S1, S3, S4 and S6: screenshots of what the edit view draws, for the measurement reports.
import { expect, type Page, test } from "@playwright/test";
import type { Rect } from "@studio/score-render";

import { ADMIN, EDITOR } from "../environment";
import { loggedIn, openScore, seedScore, typeBeats } from "../pages";
import { logInAsAdmin, openEditView, placeCursor } from "./editView";
import { screenshotPath, writeData } from "./output";
import { demoScore, perfScore } from "./scores";

// Twice the pixels, so that the small things (the mark, the accidentals) can be read.
test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 620 } });

/** Where the score starts on the page, below the header and the toolbar. */
async function scoreTop(page: Page): Promise<number> {
  return (await page.locator("[data-scroller]").boundingBox())!.y;
}

/** The first system of the score. */
async function firstSystem(page: Page, height = 440): Promise<Rect> {
  return { x: 0, y: await scoreTop(page), width: 1280, height };
}

async function demo(page: Page, bars: number, parts: number, only?: number): Promise<void> {
  await openEditView(page, demoScore({ bars, parts }), only);
  await page.waitForTimeout(600); // the pieces on screen are painted just after the layout
}

test.beforeEach(async ({ page }) => {
  await logInAsAdmin(page);
});

test("S1: where the alphaTab mark appears", async ({ page }) => {
  await demo(page, 12, 3);
  await page.screenshot({ path: screenshotPath("s1-mark-12-bars-3-parts.png"), clip: await firstSystem(page) });
  // Around the area the edit view keeps clear of the mark.
  const reserved = (await page.locator("[data-reserved]").first().boundingBox())!;
  await page.screenshot({ path: screenshotPath("s1-mark-zoom.png"), clip: { x: reserved.x - 20, y: reserved.y - 10, width: reserved.width + 40, height: reserved.height + 30 } });
  // The cases around the limits the research reported (no mark up to 10 bars and 2 tracks).
  const cases: [number, number, number | undefined][] = [
    [10, 2, undefined],
    [11, 2, undefined],
    [10, 3, undefined],
    [12, 3, 0],
  ];
  for (const [bars, parts, only] of cases) {
    await demo(page, bars, parts, only);
    const name = `s1-${bars}-bars-${parts}-parts${only === undefined ? "" : "-1-shown"}.png`;
    await page.screenshot({ path: screenshotPath(name), clip: await firstSystem(page, 260) });
  }
});

test("S3: the cursor on a tablature beat, a drum beat, a notation beat and an empty bar", async ({ page }) => {
  await demo(page, 12, 3);
  const rects: Record<string, unknown> = {};
  const shoot = async (name: string, part: number, bar: number, beat: number, line: number): Promise<void> => {
    await placeCursor(page, part, bar, beat, line);
    const [rect, noteHeads] = await page.evaluate(() => [window.__studioMeasure!.cursorRect(), window.__studioMeasure!.noteHeads()] as const);
    expect(rect).not.toBeNull();
    rects[name] = { part, bar, beat, line, rect, noteHeads };
    await page.screenshot({ path: screenshotPath(`${name}.png`), clip: await firstSystem(page) });
  };
  // Guitar, bar 1, second beat: fret 2 on string 5. Then the same beat on string 2, where there is no note.
  await shoot("s3-tab-on-a-note", 0, 0, 1, 5);
  await shoot("s3-tab-on-an-empty-string", 0, 0, 1, 2);
  // Drums, bar 1, third beat: the snare sits in the second space from the top (position 3).
  await shoot("s3-drums", 1, 0, 2, 3);
  // Keys, bar 1, third beat: D flat sits just under the staff (position 9).
  await shoot("s3-notation", 2, 0, 2, 9);
  // Guitar, bar 6: empty, the cursor stands before the first beat, on string 3.
  await shoot("s3-empty-bar", 0, 5, -1, 3);
  writeData("s3-cursor-rects.json", rects);
});

test("S6: drum pieces and the spelling of pitches as the score has them", async ({ page }) => {
  await demo(page, 12, 3);
  // Drums and keys, bars 1 to 3.
  await page.screenshot({ path: screenshotPath("s6-drums-and-spelling.png"), clip: { x: 0, y: (await scoreTop(page)) + 230, width: 720, height: 220 } });
});

test("S4: the edit view with two members' input, for the report", async ({ browser }) => {
  const viewport = { width: 1280, height: 420 };
  const id = seedScore({ title: "量測", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }] });
  const anna = await loggedIn(browser, ADMIN, { viewport });
  const ben = await loggedIn(browser, EDITOR, { viewport });
  await openScore(anna, id);
  await openScore(ben, id);
  await placeCursor(anna, 0, 3, -1, 6);
  await placeCursor(ben, 0, 3, -1, 1);
  await Promise.all([typeBeats(anna, [1, 2, 3, 4]), typeBeats(ben, [7, 8, 9, 7])]);
  await anna.waitForTimeout(1500);
  await anna.screenshot({ path: screenshotPath("s4-member-a.png") });
  await ben.screenshot({ path: screenshotPath("s4-member-b.png") });
});

test("S2: the score the latency is measured on, all five parts and one part", async ({ page }) => {
  // The 100 × 5 score, as latency.spec.ts measures it.
  const scoreId = perfScore();
  for (const [only, name] of [
    [undefined, "s2-score-5-parts.png"],
    [0, "s2-score-1-part.png"],
  ] as const) {
    await openEditView(page, scoreId, only);
    await placeCursor(page, 0, 2, 0, 2);
    await page.waitForTimeout(800);
    await page.screenshot({ path: screenshotPath(name) });
  }
});
