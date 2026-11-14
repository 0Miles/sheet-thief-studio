// Playing a score in the edit views (#31; docs/spec/playback.md, section 4, and docs/spec/views.md,
// section 2): from the cursor's bar, clicks that only move the cursor, and playback kept on
// screen until the member presses a key. Every key and click goes through the real keyboard and
// mouse; the page is read through the DOM and `window.__studioTest`. How it sounds is for a
// person to judge (#41): here the positions and the states are checked.
import { expect, type Page, test } from "@playwright/test";

import { overlaps } from "../src/overlay";
import { strings } from "../src/strings";
import { ADMIN, EDITOR, VIEWER } from "./environment";
import { cursorOf, loggedIn, openScore, pageErrors, scoreOf, seedScore } from "./pages";

const text = strings.score.player;

function seed(bars?: number): string {
  return seedScore({
    title: "播放測試",
    owner: ADMIN.username,
    members: [
      { username: EDITOR.username, role: "editor" },
      { username: VIEWER.username, role: "viewer" },
    ],
    bars,
  });
}

/** Open the score and wait until it is drawn, in step with the server, and its sound is ready. */
async function openToPlay(page: Page, id: string): Promise<void> {
  await openScore(page, id);
  await expect(page.locator('[data-player="paused"]')).toBeVisible({ timeout: 30_000 });
}

/**
 * From now on, write down every bar the toolbar shows as playing, in the order it shows them
 * (each once, as it changes); `barsShown` reads them back.
 */
async function recordBarsShown(page: Page): Promise<void> {
  await page.evaluate(() => {
    const shown: number[] = [];
    (window as unknown as { barsShown: number[] }).barsShown = shown;
    const toolbar = document.querySelector("[data-player]")!;
    new MutationObserver(() => {
      const bar = document.querySelector("[data-playing-bar]")?.getAttribute("data-bar");
      if (bar != null && shown.at(-1) !== Number(bar)) shown.push(Number(bar));
    }).observe(toolbar, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}

function barsShown(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as { barsShown: number[] }).barsShown);
}

/** Each bar shown is the one after the bar shown before it: playback went on, it never jumped. */
function oneAfterAnother(bars: number[]): boolean {
  return bars.every((bar, index) => index === 0 || bar === bars[index - 1]! + 1);
}

/** Wait until the toolbar has shown this bar playing (a 4/4 bar lasts 2 seconds at 120). */
async function untilShown(page: Page, bar: number): Promise<void> {
  await expect.poll(() => barsShown(page), { timeout: 15_000 }).toContain(bar);
}

test("with the cursor in bar 5, playing starts at bar 5 and goes on; stop ends it", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  const start = await scoreOf(page);
  for (let bar = 1; bar < 5; bar++) await page.keyboard.press("ArrowRight");
  expect(await cursorOf(page)).toMatchObject({ barId: start.bars[4]!.id });
  await expect(page.locator("[data-playing-bar]")).toHaveCount(0);

  await recordBarsShown(page);
  await page.getByRole("button", { name: text.play }).click();
  await expect(page.locator('[data-player="playing"]')).toBeVisible();
  await untilShown(page, 6);
  expect(await barsShown(page)).toEqual([5, 6]);
  // Playing moves no cursor.
  expect(await cursorOf(page)).toMatchObject({ barId: start.bars[4]!.id });

  await page.getByRole("button", { name: text.stop }).click();
  await expect(page.locator('[data-player="paused"]')).toBeVisible();
  await expect(page.locator("[data-playing-bar]")).toHaveCount(0);
  await expect(page.locator("[data-playhead]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a click on the score while it plays moves the cursor there, and playback goes on where it was; so does a change", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  const start = await scoreOf(page);
  // Where bar 6 is drawn, to click on it later: the cursor shows it.
  for (let bar = 1; bar < 6; bar++) await page.keyboard.press("ArrowRight");
  const sixth = (await page.locator("[data-cursor]").boundingBox())!;
  for (let bar = 1; bar < 6; bar++) await page.keyboard.press("ArrowLeft");
  expect(await cursorOf(page)).toMatchObject({ barId: start.bars[0]!.id });

  await recordBarsShown(page);
  // Space plays, as the toolbar's button does.
  await page.keyboard.press("Space");
  await untilShown(page, 2);
  await page.mouse.click(sixth.x + sixth.width / 2, sixth.y + sixth.height / 2);
  expect(await cursorOf(page)).toMatchObject({ barId: start.bars[5]!.id, line: 1 });
  await untilShown(page, 3);

  // A fret typed in bar 6 while it plays: the sound is made again once typing stops, and
  // playback goes on from where it was, without going back.
  await page.keyboard.press("5");
  await expect.poll(async () => (await scoreOf(page)).parts[0]!.content[start.bars[5]!.id]?.["0:0"]?.[0]?.notes.s1?.fret).toBe(5);
  await untilShown(page, 4);
  const shown = await barsShown(page);
  expect(shown[0]).toBe(1);
  expect(oneAfterAnother(shown), shown.join(", ")).toBe(true);
  await expect(page.locator('[data-player="playing"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test("a Viewer plays from the cursor too", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, VIEWER);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await recordBarsShown(page);
  await page.keyboard.press("Space");
  await untilShown(page, 4);
  expect(await barsShown(page)).toEqual([3, 4]);
  await page.keyboard.press("Space");
  await expect(page.locator('[data-player="paused"]')).toBeVisible();
  // Paused, playback stays where it was.
  await expect(page.locator("[data-playing-bar]")).toHaveAttribute("data-bar", "4");
  expect(errors).toEqual([]);
});

test("at the start of every bar, playback is drawn where the cursor is in that bar, clear of the reserved areas", async ({ browser }) => {
  const id = seed(12);
  const page = await loggedIn(browser, ADMIN);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  const scroller = page.locator("[data-scroller]");
  const playhead = page.locator("[data-playhead]");
  const reserved = await Promise.all((await page.locator("[data-reserved]").all()).map((area) => area.boundingBox()));
  expect(reserved).not.toHaveLength(0);

  for (let bar = 1; bar <= 12; bar++) {
    if (bar > 1) await page.keyboard.press("ArrowRight");
    // Every bar is empty: its one beat, the rest that fills it, lasts the whole bar, so that
    // playback paused right after it starts is still on the bar's first beat.
    await page.keyboard.press("Space");
    await expect(page.locator('[data-player="playing"]')).toBeVisible();
    await page.keyboard.press("Space");
    await expect(page.locator('[data-player="paused"]')).toBeVisible();
    await expect(page.locator("[data-playing-bar]")).toHaveAttribute("data-bar", String(bar));
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);

    // The cursor in the append slot of the empty voice is at the left edge of the bar's beat, on
    // the top string; playback is drawn from that edge, the whole height of the system, but for
    // what it would cover of a reserved area: from the top of the system down to that area's
    // bottom is cut away (src/overlay.ts).
    const cursor = (await page.locator("[data-cursor]").boundingBox())!;
    const played = (await playhead.boundingBox())!;
    expect(played.x, `bar ${bar}`).toBeCloseTo(cursor.x, 1);
    const cutAt = reserved.find((area) => Math.abs(played.y - (area!.y + area!.height)) < 0.01);
    expect(played.y <= cursor.y || cutAt !== undefined, `bar ${bar}: ${played.y} is below the cursor's ${cursor.y}`).toBe(true);
    expect(played.y + played.height, `bar ${bar}`).toBeGreaterThanOrEqual(cursor.y + cursor.height);
    for (const area of reserved) expect(overlaps(played, area!), `bar ${bar}`).toBe(false);
  }
  expect(errors).toEqual([]);
});

test("playback that goes off screen is followed; after an arrow key or a scroll it no longer is, until play is pressed again", async ({ browser }) => {
  const id = seed(24);
  // Low enough that the second system of the score is not all on screen with the page at its top.
  const page = await loggedIn(browser, ADMIN, { viewport: { width: 1280, height: 360 } });
  const errors = pageErrors(page);
  await openToPlay(page, id);
  const scroller = page.locator("[data-scroller]");
  const playhead = page.locator("[data-playhead]");
  const scrollTop = () => scroller.evaluate((element) => element.scrollTop);
  const view = (await scroller.boundingBox())!;
  /** Playback is drawn all in sight. */
  async function inSight(): Promise<boolean> {
    const box = (await playhead.boundingBox())!;
    return box.y >= view.y && box.y + box.height <= view.y + view.height;
  }

  // The last bar of the first system: the cursor goes on to the next one, a line lower, and back.
  const contentTop = async () => (await page.locator("[data-cursor]").boundingBox())!.y - view.y + (await scrollTop());
  const firstTop = await contentTop();
  let last = 1;
  while (true) {
    await page.keyboard.press("ArrowRight");
    if ((await contentTop()) !== firstTop) break;
    last += 1;
  }
  await page.keyboard.press("ArrowLeft");
  /** Back to the top of the page, with the wheel (it stops following, but nothing plays yet). */
  async function toTop(): Promise<void> {
    await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
    await page.mouse.wheel(0, -2000);
    await expect.poll(scrollTop).toBe(0);
  }
  await toTop();
  await recordBarsShown(page);

  // Played from the end of the first system into the second: the page scrolls with it.
  await page.keyboard.press("Space");
  await untilShown(page, last + 1);
  await expect.poll(scrollTop).toBeGreaterThan(0);
  await expect.poll(inSight).toBe(true);
  await page.getByRole("button", { name: text.stop }).click();
  await toTop();

  // An arrow key while it plays (the cursor is on the top string already: ↑ does not move it,
  // so the page has no cursor to show): from then on the page stays where it is.
  const cursor = await cursorOf(page);
  await page.keyboard.press("Space");
  await expect(page.locator('[data-player="playing"]')).toBeVisible();
  await page.keyboard.press("ArrowUp");
  expect(await cursorOf(page)).toEqual(cursor);
  // A whole bar into the second system, which is not all in sight.
  await untilShown(page, last + 2);
  expect(await inSight()).toBe(false);
  expect(await scrollTop()).toBe(0);

  // Play pressed again (pause, then play: it goes on from where it was): followed again.
  await page.keyboard.press("Space");
  await expect(page.locator('[data-player="paused"]')).toBeVisible();
  await page.keyboard.press("Space");
  await expect.poll(scrollTop).toBeGreaterThan(0);
  await expect.poll(inSight).toBe(true);
  expect(oneAfterAnother((await barsShown(page)).slice(2)), (await barsShown(page)).join(", ")).toBe(true);

  // Scrolled by the member while it plays, here a little with the wheel: from then on the page
  // stays where they put it.
  await page.getByRole("button", { name: text.stop }).click();
  await toTop();
  await recordBarsShown(page);
  await page.keyboard.press("Space");
  await expect(page.locator('[data-player="playing"]')).toBeVisible();
  await page.mouse.wheel(0, 10);
  await expect.poll(scrollTop).toBeGreaterThan(0);
  const scrolled = await scrollTop();
  await untilShown(page, last + 2);
  expect(await barsShown(page)).toEqual([last, last + 1, last + 2]);
  expect(await inSight()).toBe(false);
  expect(await scrollTop()).toBe(scrolled);
  expect(errors).toEqual([]);
});

test("further into a bar of several beats, playback is drawn on the beat played", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  // Two half notes in the first bar: a quarter note made one step longer, then one of the same length.
  await page.keyboard.press("3");
  await page.keyboard.press("-");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("5");
  const start = await scoreOf(page);
  expect(start.parts[0]!.content[start.bars[0]!.id]!["0:0"]!.map((beat) => beat.value)).toEqual([2, 2]);
  /** The middle of the cursor on the beat it is on, in x. */
  const middle = async () => {
    const box = (await page.locator("[data-cursor]").boundingBox())!;
    return box.x + box.width / 2;
  };
  const second = await middle();
  await page.keyboard.press("ArrowLeft");
  const first = await middle();

  // Every place playback is drawn at, in order, each once.
  await page.evaluate(() => {
    const drawn: { x: number; width: number }[] = [];
    (window as unknown as { playheads: typeof drawn }).playheads = drawn;
    new MutationObserver(() => {
      const box = document.querySelector("[data-playhead]")?.getBoundingClientRect();
      if (box && drawn.at(-1)?.x !== box.x) drawn.push({ x: box.x, width: box.width });
    }).observe(document.querySelector("[data-scroller]")!, { subtree: true, childList: true, attributes: true });
  });
  await recordBarsShown(page);
  await page.keyboard.press("Space");
  await untilShown(page, 2);
  const [onFirst, onSecond] = await page.evaluate(() => (window as unknown as { playheads: { x: number; width: number }[] }).playheads);
  const holds = (box: { x: number; width: number } | undefined, x: number) => box !== undefined && box.x <= x && x <= box.x + box.width;
  expect(holds(onFirst, first) && !holds(onFirst, second)).toBe(true);
  expect(holds(onSecond, second) && !holds(onSecond, first)).toBe(true);
  expect(errors).toEqual([]);
});
