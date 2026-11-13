// S1, S3 and S6: screenshots of what the renderer draws, for docs/spike-report.md.
import { expect, type Page, test } from "@playwright/test";

import { ADMIN } from "../environment";
import { createScore, loggedIn } from "../pages";
import { openScore, placeCursor, typeBeats } from "../studio";
import { screenshotPath, writeData } from "./output";

// Twice the pixels, so that the small things (the mark, the accidentals) can be read.
test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 620 } });

/** The first system of the page, below the toolbar. */
const FIRST_SYSTEM = { x: 0, y: 40, width: 1280, height: 440 };

async function demo(page: Page, bars: number, parts: number, extra = ""): Promise<void> {
  await openScore(page, `/local?player=0&bars=${bars}&parts=${parts}${extra}`);
  await page.waitForTimeout(600); // the pieces on screen are painted just after the layout
}

test("S1: where the alphaTab mark appears", async ({ page }) => {
  await demo(page, 12, 3);
  await page.screenshot({ path: screenshotPath("s1-mark-12-bars-3-parts.png"), clip: FIRST_SYSTEM });
  await page.screenshot({ path: screenshotPath("s1-mark-zoom.png"), clip: { x: 1150, y: 136, width: 110, height: 30 } });
  // The cases around the limits the research reported (no mark up to 10 bars and 2 tracks).
  const cases: [number, number, string][] = [
    [10, 2, ""],
    [11, 2, ""],
    [10, 3, ""],
    [12, 3, "&show=0"],
  ];
  for (const [bars, parts, extra] of cases) {
    await demo(page, bars, parts, extra);
    const name = `s1-${bars}-bars-${parts}-parts${extra ? "-1-shown" : ""}.png`;
    await page.screenshot({ path: screenshotPath(name), clip: { x: 0, y: 40, width: 1280, height: 260 } });
  }
});

test("S3: the cursor on a tablature beat, a drum beat, a notation beat and an empty bar", async ({ page }) => {
  await demo(page, 12, 3);
  const rects: Record<string, unknown> = {};
  const shoot = async (name: string, part: number, bar: number, beat: number, line: number): Promise<void> => {
    await placeCursor(page, part, bar, beat, line);
    const rect = await page.evaluate(() => window.__studio!.cursorRect());
    expect(rect).not.toBeNull();
    rects[name] = { part, bar, beat, line, rect };
    await page.screenshot({ path: screenshotPath(`${name}.png`), clip: FIRST_SYSTEM });
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
  await page.screenshot({ path: screenshotPath("s6-drums-and-spelling.png"), clip: { x: 0, y: 270, width: 720, height: 220 } });
});

test("the spike page with two members' input, for the report", async ({ browser }) => {
  // Co-editing takes a score the server made, opened by a logged-in member (#6).
  const viewport = { width: 1280, height: 420 };
  const anna = await loggedIn(browser, ADMIN, { viewport });
  const ben = await loggedIn(browser, ADMIN, { viewport });
  const id = await createScore(anna, "量測");
  await openScore(anna, `/spike/${id}?player=0`);
  await expect.poll(() => anna.evaluate(() => window.__studio!.synced())).toBe(true);
  await openScore(ben, `/spike/${id}?player=0`);
  await placeCursor(anna, 0, 3, -1, 6);
  await placeCursor(ben, 0, 3, -1, 1);
  await Promise.all([typeBeats(anna, [1, 2, 3, 4]), typeBeats(ben, [7, 8, 9, 7])]);
  await anna.waitForTimeout(1500);
  await anna.screenshot({ path: screenshotPath("s4-member-a.png") });
  await ben.screenshot({ path: screenshotPath("s4-member-b.png") });
});

test("S2: the score the latency is measured on, all five parts and one part", async ({ page }) => {
  await openScore(page, "/local?seed=perf&player=0");
  await placeCursor(page, 0, 2, 0, 2);
  await page.waitForTimeout(800);
  await page.screenshot({ path: screenshotPath("s2-score-5-parts.png") });
  await openScore(page, "/local?seed=perf&player=0&show=0");
  await placeCursor(page, 0, 2, 0, 2);
  await page.waitForTimeout(800);
  await page.screenshot({ path: screenshotPath("s2-score-1-part.png") });
});
