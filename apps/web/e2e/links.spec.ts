// Read-only links (#14; docs/spec/accounts.md, section 7; docs/spec/views.md, section 5): the
// Owner makes one on the settings page, a browser with no cookie opens it and follows the score
// live, and revoking it disconnects that browser. The page is read through `window.__studioTest`
// and the DOM only.
import { expect, type Page, test } from "@playwright/test";
import type { BeatJSON } from "@studio/score-model";

import { strings } from "../src/strings";
import { ADMIN } from "./environment";
import { beatsIn, createScore, loggedIn, pageErrors } from "./pages";

/** The beats of the first voice of the first bar of the first part, as the page holds them. */
async function firstBeats(page: Page): Promise<BeatJSON[]> {
  const score = await page.evaluate(() => window.__studioTest!.scoreJson());
  return score === null ? [] : beatsIn(score, 0, 0);
}

test("an Owner makes a read-only link; a browser without cookies opens it read-only and follows the score live, until the link is revoked", async ({ browser }) => {
  const owner = await loggedIn(browser, ADMIN, { permissions: ["clipboard-read", "clipboard-write"] });
  const ownerErrors = pageErrors(owner);
  const title = `唯讀連結 ${Date.now()}`;
  const id = await createScore(owner, title);

  await owner.goto(`/scores/${id}/settings`);
  const text = strings.settings.link;
  await expect(owner.getByText(text.none)).toBeVisible();
  await owner.getByRole("button", { name: text.make }).click();
  await expect(owner.getByLabel(text.address)).toHaveValue(/\/s\/[A-Za-z0-9_-]{43}$/);
  await owner.getByRole("button", { name: text.copy }).click();
  await expect(owner.getByRole("button", { name: text.copied })).toBeVisible();
  const link = await owner.evaluate(() => navigator.clipboard.readText());
  expect(link).toBe(await owner.getByLabel(text.address).inputValue());
  const path = new URL(link).pathname;

  // A browser of its own, never logged in.
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  const guestErrors = pageErrors(guest, [{ status: 404, path: `/api${path}` }]);
  await guest.goto(link);
  await expect(guest.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(guest.locator('[data-sync="synced"]')).toHaveText(strings.guest.sync.synced);
  await expect(guest.getByRole("heading", { name: title })).toBeVisible();
  expect(new URL(guest.url()).pathname).toBe(path);
  expect(await guestContext.cookies()).toEqual([]);
  // Read-only: nothing to type into, no cursor.
  expect(await guest.evaluate(() => window.__studioTest!.cursor())).toBeNull();
  expect(await firstBeats(guest)).toEqual([]);

  // The Owner types a fret on the score: the guest's page follows.
  const editing = await owner.context().newPage();
  const editingErrors = pageErrors(editing);
  await editing.goto(`/scores/${id}`);
  await expect(editing.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(editing.locator('[data-sync="synced"]')).toBeVisible();
  await editing.keyboard.press("5");
  await expect(editing.locator('[data-sync="synced"]')).toBeVisible();
  await expect.poll(async () => (await firstBeats(guest)).map((beat) => beat.notes.s1?.fret)).toEqual([5]);

  // From here on, whether the Owner's score page ever loses its connection, even for a moment.
  await editing.evaluate(() => {
    const page = window as { wentOffline?: boolean };
    page.wentOffline = false;
    new MutationObserver(() => {
      if (document.querySelector('[data-sync="offline"]')) page.wentOffline = true;
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["data-sync"] });
  });

  // Revoked: the guest's page says it is disconnected, for good.
  await owner.getByRole("button", { name: text.revoke }).click();
  await expect(owner.getByText(text.none)).toBeVisible();
  await expect(guest.locator('[data-sync="offline"]')).toHaveText(strings.guest.sync.offline);
  await expect(guest.getByText(strings.guest.gone)).toBeVisible();
  // The Owner's own connection stayed open: never offline, and what it types now reaches the
  // server, as a page opened afresh reads it from there.
  await editing.keyboard.press("ArrowRight");
  await editing.keyboard.press("7");
  await owner.goto(`/scores/${id}`);
  await expect(owner.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await firstBeats(owner)).map((beat) => beat.notes.s1?.fret)).toEqual([5, 7]);
  expect(await editing.evaluate(() => (window as { wentOffline?: boolean }).wentOffline)).toBe(false);

  expect(ownerErrors).toEqual([]);
  expect(editingErrors).toEqual([]);
  expect(guestErrors).toEqual([]);
  await guestContext.close();
});
