// The Read view (#32; docs/spec/views.md, sections 5-7 and 9): for guests and for any member on a
// device that cannot be typed on. A click sends playback there, a phone shows one part at a time
// with its player at the bottom, and the parts shown and the zoom are each member's own, kept in
// this browser. Every choice goes through the real page; the page is read through the DOM and
// `window.__studioTest`.
import { type BrowserContextOptions, expect, type Page, test } from "./test";

import { overlaps } from "../src/overlay";
import { strings } from "../src/strings";
import { ADMIN, EDITOR } from "./environment";
import { cursorOf, drawn, loggedIn, pageErrors, scoreOf, seedScore, soundReady } from "./pages";

const text = strings.score;

/** A phone held upright (the Browser pane's mobile preset): narrower than 768 px, touch, no fine pointer. */
const PHONE: BrowserContextOptions = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true };
/** A tablet's width, or a narrow desktop window: the wide Read view, which cannot be typed on. */
const TABLET: BrowserContextOptions = { viewport: { width: 900, height: 900 } };

/** A score of three parts, the Editor a member of it. */
function seed(bars?: number): string {
  return seedScore({
    title: "看譜測試",
    owner: ADMIN.username,
    members: [{ username: EDITOR.username, role: "editor" }],
    bars,
    parts: [
      { name: "貝斯", kind: "fretted" },
      { name: "鼓", kind: "percussion" },
    ],
  });
}

/** Open a score and wait until it is drawn, in step with the server, and its sound is ready. */
async function openToRead(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await drawn(page);
  await soundReady(page);
}

/** The parts the page shows, by id, as it asked the renderer to draw them. */
const partsShown = (page: Page) => page.locator("[data-parts]");

/**
 * The parts drawn, by name, in the score's order: the renderer writes each part's name beside
 * its staff, as text of the drawing.
 */
async function namesDrawn(page: Page, names: string[]): Promise<string[]> {
  const drawing = (await page.locator("[data-ready]").textContent()) ?? "";
  return names.filter((name) => drawing.includes(name));
}

/**
 * No overlay and no bar of the page covers a reserved area, with the score scrolled to its top.
 * The player is never over the score at all (docs/spec/views.md, section 7): on a phone it and
 * the drawer, when open, are below where the score scrolls; wide, the toolbar holding it is above.
 */
async function clearOfReserved(page: Page, playbar: "[data-playbar]" | "[data-player]"): Promise<void> {
  const scroller = page.locator("[data-scroller]");
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
  const score = (await scroller.boundingBox())!;
  if (playbar === "[data-playbar]") {
    const below = [page.locator(playbar), ...(await page.locator("[data-drawer]").all())];
    for (const part of below) expect((await part.boundingBox())!.y, "below the score").toBeGreaterThanOrEqual(score.y + score.height);
  } else {
    const toolbar = (await page.locator("main > header").boundingBox())!;
    expect(toolbar.y + toolbar.height, "the toolbar is above the score").toBeLessThanOrEqual(score.y);
  }
  const reserved = await Promise.all((await page.locator("[data-reserved]").all()).map((area) => area.boundingBox()));
  expect(reserved).not.toHaveLength(0);
  const bar = (await page.locator(playbar).boundingBox())!;
  const playhead = (await page.locator("[data-playhead]").boundingBox())!;
  for (const area of reserved) {
    expect(overlaps(bar, area!), `${playbar} over ${JSON.stringify(area)}`).toBe(false);
    expect(overlaps(playhead, area!), `the playhead over ${JSON.stringify(area)}`).toBe(false);
  }
}

test("on a phone a member sees one part at a time; the part chosen is shown again after a reload", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR, PHONE);
  const errors = pageErrors(page);
  await openToRead(page, `/scores/${id}`);
  await expect(page.locator("main")).toHaveAttribute("data-view", "read");
  await expect(page.locator("main")).toHaveAttribute("data-layout", "narrow");
  const { parts } = await scoreOf(page);
  const [first, second] = parts;
  const names = parts.map((part) => part.name);
  // The first part, when none was chosen yet.
  await expect(partsShown(page)).toHaveAttribute("data-parts", first!.id);
  await expect.poll(() => namesDrawn(page, names)).toEqual([first!.name]);
  await expect(page.locator("[data-cursor]")).toHaveCount(0);

  await page.locator("[data-part-switcher]").selectOption({ label: second!.name });
  await expect(partsShown(page)).toHaveAttribute("data-parts", second!.id);
  await expect.poll(() => namesDrawn(page, names)).toEqual([second!.name]);

  // Opened again: the page loads anew.
  await openToRead(page, `/scores/${id}`);
  await expect(partsShown(page)).toHaveAttribute("data-parts", second!.id);
  await expect(page.locator("[data-part-switcher]")).toHaveValue(second!.id);
  await expect.poll(() => namesDrawn(page, names)).toEqual([second!.name]);
  expect(errors).toEqual([]);
});

test("900 px wide, a member gets the wide Read view: every part, no cursor, and a click on bar 3 sends playback there", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR, TABLET);
  const errors = pageErrors(page);
  await openToRead(page, `/scores/${id}`);
  await expect(page.locator("main")).toHaveAttribute("data-layout", "wide");
  const json = await scoreOf(page);
  await expect(partsShown(page)).toHaveAttribute("data-parts", json.parts.map((part) => part.id).join(","));
  const names = json.parts.map((part) => part.name);
  await expect.poll(() => namesDrawn(page, names)).toEqual(names);
  await expect(page.locator("[data-cursor]")).toHaveCount(0);
  expect(await cursorOf(page)).toBeNull();
  const playing = page.locator("[data-playing-bar]");
  // Playback is shown from the start, where it is.
  await expect(playing).toHaveAttribute("data-bar", "1");

  // Where bar 3 is drawn: played up to it, paused there, and stopped (back at the start).
  await page.getByRole("button", { name: text.player.play }).click();
  await expect(playing).toHaveAttribute("data-bar", "3", { timeout: 15_000 });
  await page.getByRole("button", { name: text.player.pause }).click();
  await expect(page.locator('[data-player="paused"]')).toBeVisible();
  await expect(playing).toHaveAttribute("data-bar", "3");
  const third = (await page.locator("[data-playhead]").boundingBox())!;
  await page.getByRole("button", { name: text.player.stop }).click();
  await expect(playing).toHaveAttribute("data-bar", "1");

  // The click moves playback, and does not start it.
  await page.mouse.click(third.x + third.width / 2, third.y + third.height / 2);
  await expect(playing).toHaveAttribute("data-bar", "3");
  await expect(page.locator('[data-player="paused"]')).toBeVisible();
  const placed = (await page.locator("[data-playhead]").boundingBox())!;
  expect(placed.x).toBeCloseTo(third.x, 0);
  expect(errors).toEqual([]);
});

test("a guest opening a read-only link gets the Read view, and can play", async ({ browser }) => {
  const id = seed();
  const owner = await loggedIn(browser, ADMIN);
  const made = await owner.request.post(`/api/scores/${id}/link`, { headers: { origin: new URL(owner.url()).origin } });
  expect(made.status()).toBe(200);
  const { token } = (await made.json()) as { token: string };

  // A browser of its own, never logged in, on a desktop that could be typed on.
  const guest = await (await browser.newContext()).newPage();
  const errors = pageErrors(guest);
  await openToRead(guest, `/s/${token}`);
  await expect(guest.locator("main")).toHaveAttribute("data-view", "read");
  await expect(guest.locator("[data-cursor]")).toHaveCount(0);
  expect(await cursorOf(guest)).toBeNull();
  await guest.getByRole("button", { name: text.player.play }).click();
  await expect(guest.locator("[data-playing-bar]")).toHaveAttribute("data-bar", "2", { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test("scrolled to the top, the player and the playhead keep clear of the reserved areas, on a phone and 900 px wide", async ({ browser }) => {
  // More than 10 bars: the reserved area is there with one part drawn too.
  const id = seed(12);
  const phone = await loggedIn(browser, EDITOR, PHONE);
  const phoneErrors = pageErrors(phone);
  await openToRead(phone, `/scores/${id}`);
  await clearOfReserved(phone, "[data-playbar]");
  // With the drawer open too: it pushes the score up, never over it.
  await phone.getByRole("button", { name: text.display.options }).click();
  await expect(phone.locator("[data-drawer]")).toBeVisible();
  await clearOfReserved(phone, "[data-playbar]");
  expect(phoneErrors).toEqual([]);

  const tablet = await loggedIn(browser, EDITOR, TABLET);
  const tabletErrors = pageErrors(tablet);
  await openToRead(tablet, `/scores/${id}`);
  await clearOfReserved(tablet, "[data-player]");
  expect(tabletErrors).toEqual([]);
});

test("a part hidden and a zoom chosen in the edit view are kept after a reload, and the Read view shows the score the same way", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openToRead(page, `/scores/${id}`);
  await expect(page.locator("main")).toHaveAttribute("data-view", "editable");
  const [first, second, third] = (await scoreOf(page)).parts;
  const names = [first!.name, second!.name, third!.name];
  const cursorHeight = async () => (await page.locator("[data-cursor]").boundingBox())!.height;
  const before = await cursorHeight();

  await page.getByText(text.display.parts).click();
  await page.getByRole("checkbox", { name: second!.name }).uncheck();
  await expect(partsShown(page)).toHaveAttribute("data-parts", `${first!.id},${third!.id}`);
  await expect.poll(() => namesDrawn(page, names)).toEqual([first!.name, third!.name]);
  await page.getByLabel(text.display.zoom).selectOption({ label: text.display.scale(1.5) });
  await expect.poll(cursorHeight).toBeCloseTo(before * 1.5, 0);

  // Opened again: the page loads anew.
  await openToRead(page, `/scores/${id}`);
  await expect(partsShown(page)).toHaveAttribute("data-parts", `${first!.id},${third!.id}`);
  await page.getByText(text.display.parts).click();
  await expect(page.getByRole("checkbox", { name: second!.name })).not.toBeChecked();
  await expect(page.getByLabel(text.display.zoom)).toHaveValue("1.5");
  expect(await cursorHeight()).toBeCloseTo(before * 1.5, 0);
  expect(await namesDrawn(page, names)).toEqual([first!.name, third!.name]);

  // The same browser, 900 px wide: the Read view, with the same options, drawn at that zoom:
  // back at 100%, the system playback is in is two thirds as tall.
  await page.setViewportSize({ width: 900, height: 900 });
  await openToRead(page, `/scores/${id}`);
  await expect(page.locator("main")).toHaveAttribute("data-view", "read");
  await expect(partsShown(page)).toHaveAttribute("data-parts", `${first!.id},${third!.id}`);
  await expect.poll(() => namesDrawn(page, names)).toEqual([first!.name, third!.name]);
  await expect(page.getByLabel(text.display.zoom)).toHaveValue("1.5");
  const systemHeight = async () => (await page.locator("[data-playhead]").boundingBox())!.height;
  const zoomed = await systemHeight();
  await page.getByLabel(text.display.zoom).selectOption({ label: text.display.scale(1) });
  await expect.poll(async () => zoomed / (await systemHeight())).toBeCloseTo(1.5, 1);
  expect(errors).toEqual([]);
});
