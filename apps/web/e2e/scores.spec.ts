// Creating a score and opening it as the server keeps it (#6; docs/spec/routes.md, section 1;
// docs/spec/security.md, section 8). The page is read through `window.__studioTest` only.
import { expect, type Page, test } from "@playwright/test";
import type { ScoreJSON } from "@studio/score-model";

import { strings } from "../src/strings";
import { ADMIN, OUTSIDER } from "./environment";
import { logIn, logInFromStart, pageErrors } from "./pages";

/** Wait until the score is drawn, then read it. */
async function drawnScore(page: Page): Promise<ScoreJSON> {
  await expect(page.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  const score = await page.evaluate(() => window.__studioTest!.scoreJson());
  expect(score).not.toBeNull();
  return score!;
}

test("a score created on / opens by itself, as the server made it, the same after reloading; / lists it, and someone else gets the 404 page", async ({ page, browser }) => {
  const errors = pageErrors(page);
  await logInFromStart(page, ADMIN);

  await page.getByRole("button", { name: strings.home.newScore }).click();
  await page.getByLabel(strings.newScore.scoreTitle).fill("測試團譜");
  await page.getByRole("button", { name: strings.newScore.create }).click();
  await expect(page).toHaveURL(/\/scores\/[0-9a-f-]{36}$/);
  const address = page.url();

  const created = await drawnScore(page);
  expect(created.title).toBe("測試團譜");
  expect(created.parts).toHaveLength(1);
  expect(created.bars).toHaveLength(8);
  await expect(page.locator('[data-sync="synced"]')).toBeVisible();

  await page.reload();
  expect(await drawnScore(page)).toEqual(created);

  await page.goto("/");
  await expect(page.getByRole("link", { name: /測試團譜/ })).toBeVisible();
  expect(errors).toEqual([]);

  // Another account, not a member: the same address shows the 404 page once logged in.
  const stranger = await (await browser.newContext()).newPage();
  const strangerErrors = pageErrors(stranger, [
    { status: 401, path: "/api/me" },
    { status: 404, path: new URL(address).pathname.replace("/scores/", "/api/scores/") },
  ]);
  await stranger.goto(address);
  await logIn(stranger, OUTSIDER.username, OUTSIDER.password);
  await expect(stranger).toHaveURL(address);
  await expect(stranger.getByRole("heading", { name: strings.notFound.title })).toBeVisible();
  expect(await stranger.evaluate(() => window.__studioTest?.scoreJson() ?? null)).toBeNull();
  expect(strangerErrors).toEqual([]);
});
