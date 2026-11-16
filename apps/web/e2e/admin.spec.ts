// The admin's page: making an account that then logs in, giving it a new temporary password,
// disabling and enabling it, handing a disabled Owner's score to a member; and that anyone else
// finds no such page
// (docs/spec/accounts.md, section 2; docs/spec/routes.md, section 1).
import { randomBytes } from "node:crypto";

import { expect, test } from "./test";

import { strings } from "../src/strings";
import { ADMIN, OUTSIDER } from "./environment";
import { logIn, loggedIn, logInFromStart, pageErrors, seedAccount, seedScore } from "./pages";

const text = strings.admin;

test("an admin makes an account on /admin, which logs in; resets its password, disables it and enables it again", async ({ page, browser }) => {
  // An account of this run's own: the test can run again, be retried, or run in another browser.
  const username = `e2e-made-${randomBytes(6).toString("hex")}`;
  const [INITIAL, TEMPORARY] = ["e2e initial password", "e2e temporary password"];
  const errors = pageErrors(page);
  await logInFromStart(page, ADMIN);
  await page.getByRole("link", { name: strings.header.admin }).click();
  await expect(page).toHaveURL("/admin");
  await expect(page.getByRole("heading", { name: text.title })).toBeVisible();
  // Nothing to do to one's own account here.
  await expect(page.locator(`[data-account="${ADMIN.username}"]`)).toContainText(text.isAdmin);
  await expect(page.locator(`[data-account="${ADMIN.username}"]`).getByRole("button")).toHaveCount(0);

  await page.getByRole("button", { name: text.newAccount }).click();
  const create = page.getByRole("dialog", { name: text.create.title });
  // A username the rules refuse is not sent.
  await create.getByLabel(text.create.username).fill("Ab");
  await create.getByLabel(text.create.displayName).fill("後台建立的帳號");
  await create.getByLabel(text.create.password).fill(INITIAL);
  await create.getByRole("button", { name: text.create.submit }).click();
  await expect(create.getByRole("alert")).toHaveText(text.rules.username);
  await create.getByLabel(text.create.username).fill(username);
  await create.getByRole("button", { name: text.create.submit }).click();
  await expect(create).toBeHidden();
  await expect(page.getByRole("status")).toHaveText(text.created(username));
  const row = page.locator(`[data-account="${username}"]`);
  await expect(row).toContainText("後台建立的帳號");
  await expect(row).toHaveAttribute("data-disabled", "false");

  // The new account logs in with the initial password, and is asked to choose its own.
  const theirs = await (await browser.newContext()).newPage();
  const theirErrors = pageErrors(theirs, [
    { status: 401, path: "/api/me" },
    { status: 401, path: "/api/auth/login" },
  ]);
  await theirs.goto("/login");
  await logIn(theirs, username, INITIAL);
  await expect(theirs).toHaveURL("/account/password");

  // A new temporary password: they are logged out wherever they were.
  await row.getByRole("button", { name: text.reset }).click();
  const reset = page.getByRole("dialog", { name: text.resetPassword.title(username) });
  await reset.getByLabel(text.resetPassword.password).fill(TEMPORARY);
  await reset.getByRole("button", { name: text.resetPassword.submit }).click();
  await expect(page.getByRole("status")).toHaveText(text.wasReset(username));
  await theirs.goto("/");
  await expect(theirs).toHaveURL("/login");
  await logIn(theirs, username, TEMPORARY);
  await expect(theirs).toHaveURL("/account/password");

  // Disabled: logged out again, and the password no longer logs in.
  await row.getByRole("button", { name: text.disable }).click();
  const confirm = page.getByRole("dialog", { name: text.disableAccount.title });
  await expect(confirm).toContainText(text.disableAccount.message(username));
  await confirm.getByRole("button", { name: text.disableAccount.confirm }).click();
  await expect(page.getByRole("status")).toHaveText(text.wasDisabled(username));
  await expect(row).toHaveAttribute("data-disabled", "true");
  await expect(row).toContainText(text.disabled);
  await theirs.goto("/");
  await expect(theirs).toHaveURL("/login");
  await logIn(theirs, username, TEMPORARY);
  await expect(theirs.getByRole("alert")).toHaveText(strings.errors.invalid_credentials);

  // Enabled again: it does.
  await row.getByRole("button", { name: text.enable }).click();
  await expect(page.getByRole("status")).toHaveText(text.wasEnabled(username));
  await expect(row).toHaveAttribute("data-disabled", "false");
  await logIn(theirs, username, TEMPORARY);
  await expect(theirs).toHaveURL("/account/password");

  expect(errors).toEqual([]);
  expect(theirErrors).toEqual([]);
});

test("an admin hands a disabled Owner's score to a member on /admin, who then finds themselves its Owner on the settings page", async ({ page, browser }, testInfo) => {
  // Accounts and a score of this run's own: the Owner is used up (disabled).
  const run = `${testInfo.project.name.slice(0, 4)}-${randomBytes(4).toString("hex")}`;
  const account = (name: string, displayName: string) => ({ username: `e2e-${name}-${run}`, displayName, password: "e2e transfer password", isAdmin: false, mustChangePassword: false });
  const owning = account("gone", "離開的擁有者");
  const taking = account("take", "接手的成員");
  seedAccount(owning);
  seedAccount(taking);
  const title = `轉移 ${run}`;
  const id = seedScore({ title, owner: owning.username, members: [{ username: taking.username, role: "viewer" }] });

  const errors = pageErrors(page);
  await logInFromStart(page, ADMIN);
  await page.goto("/admin");
  const row = page.locator(`[data-account="${owning.username}"]`);
  // Its Owner can log in: no admin business.
  await expect(row).toHaveAttribute("data-disabled", "false");
  await expect(row.locator(`[data-score="${id}"]`)).toHaveCount(0);

  await row.getByRole("button", { name: text.disable }).click();
  await page.getByRole("dialog", { name: text.disableAccount.title }).getByRole("button", { name: text.disableAccount.confirm }).click();
  await expect(row).toHaveAttribute("data-disabled", "true");
  // Beside the disabled account: the score's title and its members who can log in, nothing of its content.
  const listed = row.getByRole("list", { name: text.orphaned.label(owning.username) }).locator(`[data-score="${id}"]`);
  await expect(listed).toContainText(title);
  await expect(listed.locator(`[data-member="${taking.username}"]`)).toHaveText(text.orphaned.member(taking.displayName, taking.username, strings.home.roles.viewer));

  await listed.getByRole("button", { name: text.orphaned.transfer }).click();
  const dialog = page.getByRole("dialog", { name: text.transfer.title(title) });
  await expect(dialog).toContainText(text.transfer.help(owning.username));
  await dialog.getByLabel(text.transfer.to).selectOption({ label: text.transfer.option(taking.displayName, taking.username) });
  await dialog.getByRole("button", { name: text.transfer.submit }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status")).toHaveText(text.transferred(title, taking.username));
  await expect(row.locator(`[data-score="${id}"]`)).toHaveCount(0);

  // The member who took it over logs in and is its Owner: the settings page lets them manage it.
  const theirs = await loggedIn(browser, taking);
  const theirErrors = pageErrors(theirs);
  await theirs.goto(`/scores/${id}/settings`);
  const members = theirs.getByRole("region", { name: strings.settings.members.title });
  await expect(members.locator(`[data-member="${taking.username}"]`)).toHaveAttribute("data-role", "owner");
  await expect(members.locator(`[data-member="${owning.username}"]`)).toHaveAttribute("data-role", "editor");
  await expect(theirs.getByRole("button", { name: strings.settings.members.add.submit })).toBeVisible();

  expect(errors).toEqual([]);
  expect(theirErrors).toEqual([]);
});

test("a username that is taken is refused in the dialog", async ({ page }) => {
  const errors = pageErrors(page, [
    { status: 401, path: "/api/me" },
    { status: 409, path: "/api/admin/accounts" },
  ]);
  await logInFromStart(page, ADMIN);
  await page.goto("/admin");
  await page.getByRole("button", { name: text.newAccount }).click();
  const create = page.getByRole("dialog", { name: text.create.title });
  await create.getByLabel(text.create.username).fill(OUTSIDER.username);
  await create.getByLabel(text.create.displayName).fill("重複的帳號");
  await create.getByLabel(text.create.password).fill("e2e initial password");
  await create.getByRole("button", { name: text.create.submit }).click();
  await expect(create.getByRole("alert")).toHaveText(strings.errors.username_taken);
  expect(errors).toEqual([]);
});

test("anyone but an admin finds the page of nothing at /admin, and no way to it", async ({ page }) => {
  const errors = pageErrors(page);
  await logInFromStart(page, OUTSIDER);
  await expect(page.getByRole("link", { name: OUTSIDER.displayName })).toBeVisible();
  await expect(page.getByRole("link", { name: strings.header.admin })).toHaveCount(0);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: strings.notFound.title })).toBeVisible();
  await expect(page).toHaveURL("/admin");
  await expect(page.getByRole("heading", { name: text.title })).toHaveCount(0);
  expect(errors).toEqual([]);
});
