// What alphaTab needs to draw the score and could not have (#151; docs/spec/playback.md, 4.1):
// the music font, or the worker script of the Read view. alphaTab 1.9 asks for neither again and
// tells no one; the page says so where the score would be, asks again by itself once the browser
// is back online, and on the member's retry. The downloads are cut short with `page.route`, as
// when the network goes while they come.
import { type BrowserContextOptions, expect, type Page, test } from "./test";

import { strings } from "../src/strings";
import { ADMIN, EDITOR } from "./environment";
import { drawn, loggedIn, pageErrors, seedScore, soundReady } from "./pages";

const text = strings.score;

/** A tablet's width: the Read view for a member, which lays out in a worker (docs/spec/views.md). */
const TABLET: BrowserContextOptions = { viewport: { width: 900, height: 900 } };

function seed(): string {
  return seedScore({ title: "載入失敗測試", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }] });
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

test("a music font that could not be had: the score says so, asks again once back online, and is drawn once it is had on retry", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  const font = "**/font/Bravura.*";
  const cut = await cutShort(page, font);
  await page.goto(`/scores/${id}`);
  const failed = page.locator("[data-draw-failed]");
  await expect(failed).toContainText(text.drawing.failed);
  await expect(page.locator('[data-ready="true"]')).toHaveCount(0);

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
  const ofDownloads = /Bravura|ERR_INTERNET_DISCONNECTED|Loading Failed, rendering cannot start/;
  expect(errors.filter((error) => !ofDownloads.test(error))).toEqual([]);
});

test("in the Read view, alphaTab's worker that could not be had: the score and the player say so, and both are back on retry", async ({ browser }) => {
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
