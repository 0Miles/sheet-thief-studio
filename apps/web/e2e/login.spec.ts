// Logging in and out through the pages, and what someone not logged in can open
// (docs/spec/routes.md, section 1).
import { expect, type Page, test } from "@playwright/test";

import { strings } from "../src/strings";
import { ADMIN } from "./environment";

/**
 * Every error the page throws or logs, collected for the test to assert there are none. The
 * browser logs each refused call too: the 401s from `refused` (by default GET /api/me, how the
 * page learns that nobody is logged in) are what the test expects, not errors.
 */
function pageErrors(page: Page, refused: string[] = ["/api/me"]): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const expected = message.text().includes("401") && refused.some((path) => message.location().url.endsWith(path));
    if (!expected) errors.push(message.text());
  });
  return errors;
}

async function logIn(page: Page, username: string, password: string): Promise<void> {
  await page.getByLabel(strings.login.username).fill(username);
  await page.getByLabel(strings.login.password).fill(password);
  await page.getByRole("button", { name: strings.login.submit }).click();
}

test("someone not logged in is sent to /login; the admin logs in to /, and logging out goes back to /login", async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto("/");
  await expect(page).toHaveURL("/login");

  await logIn(page, ADMIN.username, ADMIN.password);
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("heading", { name: strings.app.name })).toBeVisible();
  await expect(page.getByText(ADMIN.displayName)).toBeVisible();

  await page.getByRole("button", { name: strings.header.logout }).click();
  await expect(page).toHaveURL("/login");
  // The session is gone on the server too, not only in the page.
  await page.goto("/");
  await expect(page).toHaveURL("/login");
  expect(errors).toEqual([]);
});

test("a wrong password is refused on the page, and the page stays on /login", async ({ page }) => {
  const errors = pageErrors(page, ["/api/auth/login"]);
  await page.goto("/login");
  await logIn(page, ADMIN.username, "not the password");
  await expect(page.getByRole("alert")).toHaveText(strings.errors.invalid_credentials);
  await expect(page).toHaveURL("/login");
  expect(errors).toEqual([]);
});

test("a page that does not exist shows the 404 page; opened before logging in, it comes after", async ({ page }) => {
  const errors = pageErrors(page);
  await page.goto("/no/such/page");
  await expect(page).toHaveURL(/\/login\?redirect=/);
  await logIn(page, ADMIN.username, ADMIN.password);
  await expect(page).toHaveURL("/no/such/page");
  await expect(page.getByRole("heading", { name: strings.notFound.title })).toBeVisible();
  expect(errors).toEqual([]);
});
