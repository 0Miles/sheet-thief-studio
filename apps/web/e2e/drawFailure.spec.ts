// What alphaTab needs to draw the score and could not have (#151; docs/spec/playback.md, 4.1):
// the music font, or the worker script of the Read view. alphaTab 1.9 asks for neither again and
// tells no one; the page says so where the score would be, asks again by itself once the browser
// is back online, and on the member's retry. The downloads are cut short with `page.route`, as
// when the network goes while they come.
// The `firefox` project runs this file too, but for the tests tagged `CHROMIUM_ONLY`
// (playwright.config.ts; docs/spec/testing.md, section 3): Chromium and Firefox both keep a font
// face that failed on the page, under a name alphaTab gives again (#198), and Firefox checks it in
// a second browser.
import { expect, type Locator, type Page, test } from "./test";

import { strings } from "../src/strings";
import { ADMIN, EDITOR } from "./environment";
import { createPhrase, drawn, loggedIn, pageErrors, ready, runName, seedScore, soundReady, TABLET } from "./pages";

const text = strings.score;
/** What the browser and alphaTab log of each download of the font cut short. */
const OF_FONT = /Bravura|ERR_INTERNET_DISCONNECTED|Loading Failed, rendering cannot start/;
/** Not run by the `firefox` project: what the browser logs of a download cut short is read as Chromium words it. */
const CHROMIUM_ONLY = { tag: "@chromium-only" };

function seed(bars?: number): string {
  return seedScore({ title: "載入失敗測試", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], ...(bars === undefined ? {} : { bars }) });
}

/** Cut every download of `url` short; how many were, so far. */
async function cutShort(page: Page, url: string): Promise<() => number> {
  let cut = 0;
  await page.route(url, (route) => {
    cut += 1;
    return route.abort("internetdisconnected");
  });
  return () => cut;
}

/** The browser goes offline and comes back. */
async function backOnline(page: Page): Promise<void> {
  await page.context().setOffline(true);
  await page.context().setOffline(false);
}

test("a music font that could not be had: the score says so, asks again once back online, and is drawn once it is had on retry", CHROMIUM_ONLY, async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  const font = "**/font/Bravura.*";
  const cut = await cutShort(page, font);
  await page.goto(`/scores/${id}`);
  const failed = page.locator("[data-draw-failed]");
  await expect(failed).toContainText(text.drawing.failed);
  await expect(page.locator('[data-ready="true"]')).toHaveCount(0);
  // A window of another size: alphaTab lays out nothing and reports it done; the score is not drawn for that.
  await page.setViewportSize({ width: 1100, height: 720 });
  await page.locator("[data-toggle-phrases]").click();
  await expect(page.locator("[data-phrase-sidebar]")).toBeVisible();
  await page.locator("[data-toggle-phrases]").click();
  await expect(page.locator('[data-ready="true"]')).toHaveCount(0);
  await expect(page.locator("[data-append-bar]")).toHaveCount(0);

  // Back online, the page asks for it again by itself; still cut short, it says so again.
  const before = cut();
  await backOnline(page);
  await expect.poll(cut).toBeGreaterThan(before);
  await expect(failed).toBeVisible();

  // To be had now: on retry, the score is drawn and plays.
  await page.unroute(font);
  await failed.getByRole("button", { name: text.drawing.retry }).click();
  await drawn(page);
  await expect(failed).toHaveCount(0);
  await soundReady(page);
  // What the browser and alphaTab log of each download cut short, and nothing else.
  expect(errors.filter((error) => !OF_FONT.test(error))).toEqual([]);
});

test("in the Read view, alphaTab's worker that could not be had: the score and the player say so, and both are back on retry", CHROMIUM_ONLY, async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR, TABLET);
  const errors = pageErrors(page);
  // The one script of both workers, the layout's and the player's.
  const worker = "**/alphaTab.worker*.js";
  const cut = await cutShort(page, worker);
  await page.goto(`/scores/${id}`);
  await expect(page.locator("main")).toHaveAttribute("data-view", "read");
  const failed = page.locator("[data-draw-failed]");
  await expect(failed).toContainText(text.drawing.failed);
  await expect(page.locator('[data-player="failed"]')).toBeVisible();
  expect(cut()).toBeGreaterThan(0);

  await page.unroute(worker);
  await failed.getByRole("button", { name: text.drawing.retry }).click();
  await drawn(page);
  await expect(failed).toHaveCount(0);
  await soundReady(page);
  const ofDownloads = /alphaTab\.worker|ERR_INTERNET_DISCONNECTED/;
  expect(errors.filter((error) => !ofDownloads.test(error))).toEqual([]);
});

test("the phrase editor, a phrase's preview beside the score and a version's preview say so too, each drawn on its own retry", CHROMIUM_ONLY, async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  const name = runName("載入失敗");
  await page.goto("/");
  const phraseId = await createPhrase(page, name);
  const font = "**/font/Bravura.*";
  await cutShort(page, font);
  const failed = page.locator("[data-draw-failed]");
  const retry = (within: Locator) => within.getByRole("button", { name: text.drawing.retry }).click();

  // The phrase editor.
  await page.goto(`/phrases/${phraseId}`);
  await expect(failed).toContainText(text.drawing.failed);
  await expect(page.locator('[data-ready="true"]')).toHaveCount(0);
  await page.unroute(font);
  await retry(failed);
  await ready(page);
  await expect(failed).toHaveCount(0);

  // The preview of a phrase in the score's sidebar: the score has its own, and its own retry.
  await cutShort(page, font);
  await page.goto(`/scores/${id}`);
  await expect(failed).toHaveCount(1);
  await page.locator("[data-toggle-phrases]").click();
  await page.locator("[data-phrase-search]").fill(name);
  await page.locator("[data-phrase]", { hasText: name }).click();
  const preview = page.locator("[data-phrase-preview]");
  await expect(preview.locator("[data-draw-failed]")).toContainText(text.drawing.failed);
  await expect(failed).toHaveCount(2);
  await page.unroute(font);
  await retry(preview.locator("[data-draw-failed]"));
  await expect(preview).toHaveAttribute("data-preview-ready", "true", { timeout: 30_000 });
  await expect(preview.locator("[data-draw-failed]")).toHaveCount(0);
  await expect(failed).toHaveCount(1);
  await retry(failed);
  await drawn(page);
  await expect(failed).toHaveCount(0);

  // The preview of a version.
  await cutShort(page, font);
  await page.goto(`/scores/${id}/versions`);
  const pane = page.locator("[data-preview-pane]");
  await expect(pane.locator("[data-draw-failed]")).toContainText(text.drawing.failed);
  await page.locator("[data-save-version]").getByLabel(strings.versions.name).fill("載入失敗");
  await page.locator("[data-save-version]").getByRole("button", { name: strings.versions.save.submit }).click();
  await page.locator("[data-version]").first().locator("[data-preview]").click();
  await expect(pane.locator("[data-draw-failed]")).toBeVisible();
  await expect(pane).not.toHaveAttribute("data-ready", "true");
  await page.unroute(font);
  await retry(pane.locator("[data-draw-failed]"));
  await expect(pane).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(pane.locator("[data-draw-failed]")).toHaveCount(0);
  // The score held open under the versions page has its own, hidden with it, and its own retry.
  await expect(failed).toHaveCount(1);
  await expect(failed).toBeHidden();
  expect(errors.filter((error) => !OF_FONT.test(error))).toEqual([]);
});

test("the player's worker alone could not be had: on the toolbar's retry the score, drawn anew, is back where it was scrolled to", CHROMIUM_ONLY, async ({ browser }) => {
  // Taller than the window.
  const id = seed(160);
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  const worker = "**/alphaTab.worker*.js";
  await cutShort(page, worker);
  await page.goto(`/scores/${id}`);
  // The edit view lays out on the page's own thread: the score is drawn, the player has no worker.
  await drawn(page);
  await expect(page.locator('[data-player="failed"]')).toBeVisible();
  const failed = page.locator("[data-draw-failed]");
  await expect(failed).toHaveCount(0);

  const scroller = page.locator("[data-scroller]");
  const scrollTop = () => scroller.evaluate((element) => element.scrollTop);
  await scroller.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(scrollTop).toBe(400);

  await page.unroute(worker);
  await page.locator("[data-player]").getByRole("button", { name: text.player.retry }).click();
  await soundReady(page);
  await drawn(page);
  await expect(failed).toHaveCount(0);
  await expect.poll(async () => Math.abs((await scrollTop()) - 400)).toBeLessThanOrEqual(1);
  const ofDownloads = /alphaTab\.worker|ERR_INTERNET_DISCONNECTED/;
  expect(errors.filter((error) => !ofDownloads.test(error))).toEqual([]);
});

// Also in Firefox: like Chromium, it keeps the font face that failed on the page, and alphaTab
// names the score's new font after the preview's, still failed there (docs/spec/playback.md, 4.1).
test("the score and a phrase's preview both failed: the score's retry draws the score alone; the preview's draws the preview, which has the keyboard from then on", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  const name = runName("兩處載入失敗");
  // On `/` since it logged in, its lists in (`logInFromStart`): not loaded again, which would have
  // the next address reached while they are asked for. Firefox aborts those requests then, and the
  // page reports the list it could not get as an error of its own (HomeView.vue).
  await createPhrase(page, name);
  const font = "**/font/Bravura.*";
  await cutShort(page, font);
  const failed = page.locator("[data-draw-failed]");
  const ofScore = page.locator("[data-scroller] [data-draw-failed]");
  const preview = page.locator("[data-phrase-preview]");
  const ofPreview = preview.locator("[data-draw-failed]");
  const retry = (within: Locator) => within.getByRole("button", { name: text.drawing.retry }).click();

  await page.goto(`/scores/${id}`);
  await expect(ofScore).toContainText(text.drawing.failed);
  await page.locator("[data-toggle-phrases]").click();
  await page.locator("[data-phrase-search]").fill(name);
  await page.locator("[data-phrase]", { hasText: name }).click();
  await expect(ofPreview).toContainText(text.drawing.failed);
  await expect(failed).toHaveCount(2);

  // To be had now. The score first: drawn, the preview still as it was.
  await page.unroute(font);
  await retry(ofScore);
  await drawn(page);
  await expect(ofScore).toHaveCount(0);
  await expect(ofPreview).toHaveCount(1);
  await expect(failed).toHaveCount(1);

  // Then the preview: its retry leaves the page, the preview has the keyboard.
  await retry(ofPreview);
  await expect(preview).toBeFocused();
  await expect(preview).toHaveAttribute("data-preview-ready", "true", { timeout: 30_000 });
  await expect(failed).toHaveCount(0);
  await expect(page.locator('[data-ready="true"]')).toBeVisible();
  // So Esc closes the preview, and only it.
  await page.keyboard.press("Escape");
  await expect(preview).toBeHidden();
  await expect(page.locator("[data-phrase-sidebar]")).toBeVisible();
  expect(errors.filter((error) => !OF_FONT.test(error))).toEqual([]);
});
