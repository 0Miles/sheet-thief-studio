// Having to change a temporary password before anything else, and one's own account page
// (docs/spec/accounts.md, section 1; docs/spec/routes.md, section 1).
import { expect, test } from "@playwright/test";

import { strings } from "../src/strings";
import { NEWCOMER } from "./environment";
import { logIn, pageErrors } from "./pages";

const text = strings.account;
const CHOSEN = "e2e password of her own";

test("an account with a temporary password is held on /account/password until it has chosen its own, then renames itself on /account", async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto("/login");
  await logIn(page, NEWCOMER.username, NEWCOMER.password);
  await expect(page).toHaveURL("/account/password");
  await expect(page.getByRole("heading", { name: text.forced.title })).toBeVisible();

  // No other page opens meanwhile.
  await page.goto("/account");
  await expect(page).toHaveURL(/\/account\/password/);
  await page.goto("/");
  await expect(page).toHaveURL("/account/password");

  // Two different passwords are not sent.
  await page.getByLabel(text.password.new, { exact: true }).fill(CHOSEN);
  await page.getByLabel(text.password.again).fill(`${CHOSEN}?`);
  await page.getByRole("button", { name: text.forced.submit }).click();
  await expect(page.getByRole("alert")).toHaveText(text.password.mismatch);
  await expect(page).toHaveURL("/account/password");

  await page.getByLabel(text.password.again).fill(CHOSEN);
  await page.getByRole("button", { name: text.forced.submit }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: strings.home.title })).toBeVisible();

  // Nothing left to change: the gate itself now leads to /account.
  await page.goto("/account/password");
  await expect(page).toHaveURL("/account");

  await page.goto("/");
  await page.getByRole("link", { name: NEWCOMER.displayName }).click();
  await expect(page).toHaveURL("/account");
  await page.getByLabel(text.displayName.label).fill("  自己取的名稱  ");
  await page.getByRole("button", { name: text.displayName.save }).click();
  await expect(page.getByRole("status")).toHaveText(text.displayName.saved);
  await page.reload();
  await expect(page.getByLabel(text.displayName.label)).toHaveValue("自己取的名稱");
  await expect(page.getByRole("link", { name: "自己取的名稱" })).toBeVisible();

  // The password she chose is the one that logs in now; logging out everywhere leaves this page too.
  await page.getByRole("button", { name: text.logoutAll.submit }).click();
  await expect(page).toHaveURL("/login");
  await logIn(page, NEWCOMER.username, CHOSEN);
  await expect(page).toHaveURL("/");
  expect(errors).toEqual([]);
});
