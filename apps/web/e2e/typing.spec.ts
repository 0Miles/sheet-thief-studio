// Typing on a score the server keeps, in the edit view (#19; docs/spec/views.md, sections 1-4
// and 9). Every key goes through the real keyboard, every click through the real mouse; the page
// is read through `window.__studioTest` and the DOM only.
import { expect, type Page, test } from "@playwright/test";
import type { BeatJSON, Cursor, ScoreJSON } from "@studio/score-model";

import { overlaps } from "../src/overlay";
import { strings } from "../src/strings";
import { ADMIN, EDITOR, VIEWER } from "./environment";
import { loggedIn, pageErrors, seedScore } from "./pages";

/** Every change typed here has reached the server. */
async function synced(page: Page): Promise<void> {
  await expect(page.locator('[data-sync="synced"]')).toBeVisible();
}

/** Open a score and wait until it is drawn and in step with the server; the score then has the keyboard. */
async function openScore(page: Page, id: string): Promise<void> {
  await page.goto(`/scores/${id}`);
  await expect(page.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await synced(page);
}

function scoreOf(page: Page): Promise<ScoreJSON> {
  return page.evaluate(() => window.__studioTest!.scoreJson()!);
}

function cursorOf(page: Page): Promise<Cursor | null> {
  return page.evaluate(() => window.__studioTest!.cursor());
}

/** The beats of the first voice of a bar (by index) of the first part. */
function beatsIn(score: ScoreJSON, bar: number): BeatJSON[] {
  return score.parts[0]!.content[score.bars[bar]!.id]?.["0:0"] ?? [];
}

function seed(bars?: number): string {
  return seedScore({
    title: "打譜測試",
    owner: ADMIN.username,
    members: [
      { username: EDITOR.username, role: "editor" },
      { username: VIEWER.username, role: "viewer" },
    ],
    ...(bars === undefined ? {} : { bars }),
  });
}

test("an Editor moves with the arrows, types a fret and shortens it; after reloading the score holds both", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  const start = await scoreOf(page);
  expect(await cursorOf(page)).toEqual({ partId: start.parts[0]!.id, barId: start.bars[0]!.id, voice: "0:0", beatId: null, at: "after", line: 1 });

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  expect(await cursorOf(page)).toMatchObject({ barId: start.bars[1]!.id, beatId: null, at: "after", line: 2 });
  await page.keyboard.press("5");
  await page.keyboard.press("+");
  await synced(page);

  await page.reload();
  await openScore(page, id);
  const typed = beatsIn(await scoreOf(page), 1);
  expect(typed).toHaveLength(1);
  expect(typed[0]).toMatchObject({ value: 8, dots: 0, notes: { s2: { fret: 5 } } });
  expect(errors).toEqual([]);
});

test("a digit in the append slot makes a new beat, and the cursor is on it; another member sees the fret", async ({ browser }) => {
  const id = seed();
  const editor = await loggedIn(browser, EDITOR);
  const owner = await loggedIn(browser, ADMIN);
  const errors = [pageErrors(editor), pageErrors(owner)];
  await openScore(editor, id);
  await openScore(owner, id);

  // The append slot of the empty voice of the first bar.
  await editor.keyboard.press("5");
  const first = beatsIn(await scoreOf(editor), 0);
  expect(first).toHaveLength(1);
  expect(await cursorOf(editor)).toMatchObject({ beatId: first[0]!.id, at: "on" });

  // The append slot after that beat: its anchor is the beat.
  await editor.keyboard.press("ArrowRight");
  expect(await cursorOf(editor)).toMatchObject({ beatId: first[0]!.id, at: "after" });
  await editor.keyboard.press("7");
  const both = beatsIn(await scoreOf(editor), 0);
  expect(both.map((beat) => beat.notes.s1?.fret)).toEqual([5, 7]);
  expect(await cursorOf(editor)).toMatchObject({ beatId: both[1]!.id, at: "on" });
  await synced(editor);

  // The Owner, in a browser context of their own, gets both frets.
  await expect.poll(async () => beatsIn(await scoreOf(owner), 0).map((beat) => beat.notes.s1?.fret)).toEqual([5, 7]);
  expect(errors.flat()).toEqual([]);
});

test("a Viewer moves the cursor but changes nothing; the notice that a Viewer cannot edit shows only the first time", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, VIEWER);
  const errors = pageErrors(page);
  await openScore(page, id);
  const before = await scoreOf(page);
  const notice = page.getByRole("status").filter({ hasText: strings.score.viewerCannotEdit });

  await page.keyboard.press("5");
  await expect(notice).toBeVisible();
  await page.keyboard.press("+");
  await page.keyboard.press("6");
  await page.getByRole("button", { name: strings.score.dismiss }).click();
  await expect(notice).toHaveCount(0);

  // The score has the keyboard again: more refused keys, then a move that is allowed.
  await page.keyboard.press("7");
  await page.keyboard.press("Delete");
  await page.keyboard.press("ArrowRight");
  expect(await cursorOf(page)).toMatchObject({ barId: before.bars[1]!.id });
  await expect(notice).toHaveCount(0);
  expect(await scoreOf(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test("at the top of a score of more than 10 bars, the cursor never covers an area reserved for the engine's mark", async ({ browser }) => {
  const id = seed(12);
  const page = await loggedIn(browser, ADMIN);
  const errors = pageErrors(page);
  await openScore(page, id);
  const reserved = page.locator("[data-reserved]");
  await expect(reserved).not.toHaveCount(0);
  const areas = await Promise.all((await reserved.all()).map((area) => area.boundingBox()));
  expect(areas).not.toContain(null);
  const scroller = page.locator("[data-scroller]");

  /** The cursor is drawn where it is now, clear of every reserved area, with the page at the top. */
  async function clearAt(bar: number, at: Cursor["at"]): Promise<void> {
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
    expect(await cursorOf(page)).toMatchObject({ barId: (await scoreOf(page)).bars[bar]!.id, at, line: 1 });
    const cursor = await page.locator("[data-cursor]").boundingBox();
    expect(cursor).not.toBeNull();
    for (const area of areas) expect(overlaps(cursor!, area!), `bar ${bar + 1}, ${at}`).toBe(false);
  }

  // On the top string, through every bar (the first system's last bar is one of them): the append
  // slot of the empty voice, a beat typed there, and the append slot after that beat.
  for (let bar = 0; bar < 12; bar++) {
    await clearAt(bar, "after");
    await page.keyboard.press("1");
    await clearAt(bar, "on");
    await page.keyboard.press("ArrowRight");
    await clearAt(bar, "after");
    await page.keyboard.press("ArrowRight");
  }
  expect(errors).toEqual([]);
});

test("a click on a beat of the score puts the cursor on that beat", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);

  await page.keyboard.press("5");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("7");
  const [first, second] = beatsIn(await scoreOf(page), 0);
  // Where the first beat is drawn: the cursor shows it.
  await page.keyboard.press("ArrowLeft");
  expect(await cursorOf(page)).toMatchObject({ beatId: first!.id, at: "on" });
  const box = (await page.locator("[data-cursor]").boundingBox())!;
  await page.keyboard.press("ArrowRight");
  expect(await cursorOf(page)).toMatchObject({ beatId: second!.id });

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(await cursorOf(page)).toMatchObject({ beatId: first!.id, at: "on", line: 1 });
  expect(errors).toEqual([]);
});
