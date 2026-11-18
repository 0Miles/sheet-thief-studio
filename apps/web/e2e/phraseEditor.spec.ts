// The phrase editor (#54; docs/spec/phrases.md, section 5): typing in a phrase saves it by itself;
// a phrase changed in another tab since is saved as a new phrase; leaving with changes not saved
// asks first; on a phone the phrase is drawn and played, and nothing is changed nor saved.
import { type BrowserContextOptions, expect, type Page, test } from "./test";

import { strings } from "../src/strings";
import { ADMIN } from "./environment";
import { beatsIn, createPhrase, loggedIn, logInFromStart, pageErrors, playerSettled, scoreOf } from "./pages";

const text = strings.phraseEditor;

/** A phone held upright (the Browser pane's mobile preset): narrower than 768 px, touch, no fine pointer. */
const PHONE: BrowserContextOptions = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true };

/** Names of this run only: the tests' database keeps the phrases of earlier runs. */
function runName(name: string): string {
  return `${name} ${test.info().repeatEachIndex}-${Date.now()}`;
}

/** Open the phrase and wait until it is drawn. */
async function openPhrase(page: Page, id: string): Promise<void> {
  await page.goto(`/phrases/${id}`);
  await expect(page.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
}

/** The frets of the first string, beat by beat, in the first bar of the phrase open on the page. */
async function fretsOf(page: Page): Promise<(number | undefined)[]> {
  return beatsIn(await scoreOf(page), 0, 0).map((beat) => beat.notes.s1?.fret);
}

/** Type these frets one beat after another, from the append slot. */
async function typeFrets(page: Page, frets: number[]): Promise<void> {
  for (const fret of frets) {
    await page.keyboard.press(String(fret));
    await page.keyboard.press("ArrowRight");
  }
}

/** The page shows what it saved: changed first, then saved. */
async function saved(page: Page): Promise<void> {
  await expect(page.locator("[data-save]")).not.toHaveAttribute("data-save", "saved");
  await expect(page.locator('[data-save="saved"]')).toBeVisible();
}

test("a blank fretted phrase opened from the library is typed in, saved a second later, and still holds it after reloading", async ({ page }) => {
  const errors = pageErrors(page);
  const name = runName("編輯器樂句");
  await logInFromStart(page, ADMIN);
  const id = await createPhrase(page, name);
  await page.goto("/phrases");
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page).toHaveURL(`/phrases/${id}`);
  await expect(page.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.locator('main[data-view="editable"]')).toBeVisible();

  await typeFrets(page, [3, 5, 7]);
  expect(await fretsOf(page)).toEqual([3, 5, 7]);
  await saved(page);

  await page.reload();
  await expect(page.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  expect(await fretsOf(page)).toEqual([3, 5, 7]);
  await expect(page.locator('[data-save="saved"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test("a phrase changed in another tab since: the page says so, and saves what it has as a new phrase", async ({ page, context }) => {
  await logInFromStart(page, ADMIN);
  const id = await createPhrase(page, runName("兩個分頁"));
  // The save refused: what this test makes happen.
  const errors = pageErrors(page, [{ status: 409, path: `/api/phrases/${id}` }]);
  const other = await context.newPage();
  const otherErrors = pageErrors(other);
  await openPhrase(page, id);
  await openPhrase(other, id);

  await typeFrets(other, [3]);
  await saved(other);

  await typeFrets(page, [5]);
  const conflict = page.locator("[data-conflict]");
  await expect(conflict).toContainText(strings.errors.revision_conflict);
  await expect(conflict.getByRole("button", { name: text.reload })).toBeVisible();
  await conflict.getByRole("button", { name: text.saveAsNew }).click();

  const dialog = page.getByRole("dialog", { name: strings.saveAsNewPhrase.title });
  const copy = runName("另存的樂句");
  await dialog.getByLabel(strings.saveAsNewPhrase.name).fill(copy);
  await dialog.getByRole("button", { name: strings.saveAsNewPhrase.save }).click();
  await expect(page).not.toHaveURL(`/phrases/${id}`);
  await expect(page).toHaveURL(/\/phrases\/[0-9a-f-]{36}$/);
  await expect(page.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: copy })).toBeVisible();
  expect(await fretsOf(page)).toEqual([5]);

  // The phrase changed elsewhere keeps what the other tab saved.
  await page.reload();
  await expect(page.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  expect(await fretsOf(page)).toEqual([5]);
  await openPhrase(other, id);
  expect(await fretsOf(other)).toEqual([3]);
  expect(errors).toEqual([]);
  expect(otherErrors).toEqual([]);
});

test("leaving the page with a change not saved yet asks first", async ({ page }) => {
  const errors = pageErrors(page);
  await logInFromStart(page, ADMIN);
  const id = await createPhrase(page, runName("離開前警告"));
  await openPhrase(page, id);

  await typeFrets(page, [9]);
  // The fret is typed: the second before it is saved has only started.
  expect(await fretsOf(page)).toEqual([9]);
  const asked = page.waitForEvent("dialog", { timeout: 10_000 });
  await page.close({ runBeforeUnload: true });
  const dialog = await asked;
  expect(dialog.type()).toBe("beforeunload");
  // Staying: the page is still there.
  await dialog.dismiss();
  expect(page.isClosed()).toBe(false);
  expect(errors).toEqual([]);
});

test("on a phone the phrase is drawn and plays; keys change nothing and nothing is saved", async ({ browser }) => {
  const page = await loggedIn(browser, ADMIN, PHONE);
  const errors = pageErrors(page);
  const id = await createPhrase(page, runName("手機樂句"));
  const writes: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" || request.method() === "PATCH") writes.push(`${request.method()} ${request.url()}`);
  });
  await openPhrase(page, id);
  await expect(page.locator('main[data-view="read"]')).toBeVisible();
  await expect(page.getByText(text.desktopOnly)).toBeVisible();
  for (const button of [text.rename, strings.score.bars.insert, strings.score.bars.remove]) await expect(page.getByRole("button", { name: button })).toHaveCount(0);

  await page.locator("[data-scroller]").focus();
  await page.keyboard.press("5");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("3");
  await page.locator("[data-scroller]").tap({ position: { x: 100, y: 100 } });
  // Past the second a save would wait for.
  await page.waitForTimeout(1500);
  expect(await fretsOf(page)).toEqual([]);
  expect(writes).toEqual([]);

  // It plays (where a browser can: the page says when it cannot).
  if ((await playerSettled(page)) === "paused") {
    await page.locator("[data-player]").getByRole("button", { name: strings.score.player.play }).click();
    await expect(page.locator('[data-player="playing"]')).toBeVisible();
  }
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
});
