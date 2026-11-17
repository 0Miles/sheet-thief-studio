// The phrase library (#53; docs/spec/phrases.md, section 4): on a desktop, making a blank phrase,
// renaming, copying and deleting one through the page; on a phone, the list and its search only.
import { type BrowserContextOptions, expect, type Locator, type Page, test } from "@playwright/test";
import { blankFragment, PART_PRESETS } from "@studio/score-model";

import { strings } from "../src/strings";
import { ADMIN } from "./environment";
import { loggedIn, logInFromStart, pageErrors } from "./pages";

const text = strings.phrases;

/** A phone held upright (the Browser pane's mobile preset): narrower than 768 px, touch, no fine pointer. */
const PHONE: BrowserContextOptions = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true };

/** Names of this run only: the tests' database keeps the phrases of earlier runs. */
function runName(name: string): string {
  return `${name} ${test.info().repeatEachIndex}-${Date.now()}`;
}

/** The row of the phrase with this name, exactly. */
function rowOf(page: Page, name: string): Locator {
  return page.getByRole("listitem").filter({ has: page.getByText(name, { exact: true }) });
}

/** A phrase made through the API as the account logged in on the page (data the test starts from). */
async function createPhrase(page: Page, name: string): Promise<void> {
  const origin = new URL(page.url()).origin;
  const response = await page.request.post("/api/phrases", { data: { name, fragment: blankFragment(PART_PRESETS.guitar6) }, headers: { origin } });
  expect(response.status()).toBe(201);
}

test("on /phrases a blank phrase is made, renamed, copied and deleted, each kept after reloading", async ({ page }) => {
  const errors = pageErrors(page);
  const name = runName("貝斯樂句");
  await logInFromStart(page, ADMIN);
  await page.getByRole("link", { name: strings.home.phrases }).click();
  await expect(page).toHaveURL("/phrases");

  // A blank phrase of the preset chosen: 4 strings, one bar.
  await page.getByRole("button", { name: text.newPhrase }).click();
  const create = page.getByRole("dialog", { name: strings.newPhrase.title });
  await expect(create.getByLabel(strings.newPhrase.name)).toHaveValue(strings.newPhrase.defaultName);
  await create.getByLabel(strings.newPhrase.name).fill(name);
  await create.getByLabel(strings.newPhrase.preset).selectOption({ label: strings.presets.bass4 });
  await create.getByRole("button", { name: strings.newPhrase.create }).click();
  await expect(create).toBeHidden();
  const made = rowOf(page, name);
  await expect(made).toContainText([text.kinds.fretted, text.strings(4), text.bars(1)].join(" · "));
  await page.reload();
  await expect(made).toBeVisible();

  const renamed = runName("新的名稱");
  await made.getByRole("button", { name: text.rename }).click();
  const rename = page.getByRole("dialog", { name: strings.renamePhrase.title });
  await expect(rename.getByLabel(strings.renamePhrase.name)).toHaveValue(name);
  await rename.getByLabel(strings.renamePhrase.name).fill(renamed);
  await rename.getByRole("button", { name: strings.renamePhrase.save }).click();
  await expect(rename).toBeHidden();
  await expect(rowOf(page, renamed)).toBeVisible();
  await expect(made).toHaveCount(0);

  const copyName = `${renamed}（副本）`;
  await rowOf(page, renamed).getByRole("button", { name: text.duplicate }).click();
  await expect(rowOf(page, copyName)).toContainText(text.strings(4));
  await page.reload();
  await expect(rowOf(page, renamed)).toBeVisible();
  await expect(rowOf(page, copyName)).toBeVisible();

  // Deleting the original leaves the copy.
  await rowOf(page, renamed).getByRole("button", { name: text.delete }).click();
  const confirm = page.getByRole("dialog", { name: strings.deletePhrase.title });
  await expect(confirm).toContainText(strings.deletePhrase.message(renamed));
  await confirm.getByRole("button", { name: strings.deletePhrase.confirm }).click();
  await expect(rowOf(page, renamed)).toHaveCount(0);
  await page.reload();
  await expect(rowOf(page, copyName)).toBeVisible();
  await expect(rowOf(page, renamed)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("on a phone /phrases lists and searches the phrases, and offers no making, renaming, copying nor deleting", async ({ browser }) => {
  const page = await loggedIn(browser, ADMIN, PHONE);
  const errors = pageErrors(page);
  const verse = runName("手機 主歌");
  const chorus = runName("手機 副歌");
  await createPhrase(page, verse);
  await createPhrase(page, chorus);

  await page.goto("/phrases");
  await expect(page.locator('main[data-can-type="false"]')).toBeVisible();
  await expect(rowOf(page, verse)).toBeVisible();
  await expect(rowOf(page, chorus)).toBeVisible();

  await page.getByLabel(text.search).fill(verse);
  await expect(rowOf(page, chorus)).toHaveCount(0);
  await expect(page.getByRole("listitem")).toHaveCount(1);
  await expect(rowOf(page, verse)).toBeVisible();

  for (const name of [text.newPhrase, text.rename, text.duplicate, text.delete]) await expect(page.getByRole("button", { name })).toHaveCount(0);
  expect(errors).toEqual([]);
});
