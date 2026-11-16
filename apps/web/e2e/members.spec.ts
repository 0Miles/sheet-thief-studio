// Members (#13; docs/spec/accounts.md, sections 3 to 6): the Owner adds an account on the
// settings page, by its whole username; that account then finds the score among its own, opens
// it, and can leave it. Accounts of the test's own: the lookups of usernames are limited by
// account, so every run, retry and browser makes its Owner anew.
import { expect, test } from "@playwright/test";

import { strings } from "../src/strings";
import { createScore, drawn, loggedIn, pageErrors, seedAccount } from "./pages";

const text = strings.settings.members;

test("an Owner adds an account as a Viewer on the settings page; that account sees the score on /, opens it, and leaves it", async ({ browser }, testInfo) => {
  const run = `${testInfo.project.name.slice(0, 4)}-${Date.now().toString(36)}`;
  const account = (name: string, displayName: string) => ({ username: `e2e-${name}-${run}`, displayName, password: "e2e members password", isAdmin: false, mustChangePassword: false });
  const owning = account("own", "擁有者帳號");
  const viewing = account("view", "新成員帳號");
  seedAccount(owning);
  seedAccount(viewing);

  const owner = await loggedIn(browser, owning);
  const title = `成員 ${run}`;
  const id = await createScore(owner, title);
  const ownerErrors = pageErrors(owner, [{ status: 404, path: `/api/scores/${id}/members` }]);
  await owner.goto(`/scores/${id}/settings`);
  const members = owner.getByRole("region", { name: text.title });
  await expect(members.locator("[data-member]")).toHaveCount(1);
  await expect(members.locator(`[data-member="${owning.username}"]`)).toHaveAttribute("data-role", "owner");

  // No such account: said, and nobody added.
  await owner.getByLabel(text.add.username).fill("e2e-nobody-at-all");
  await owner.getByRole("button", { name: text.add.submit }).click();
  await expect(owner.getByRole("alert")).toHaveText(strings.errors.account_not_found);
  await expect(members.locator("[data-member]")).toHaveCount(1);

  await owner.getByLabel(text.add.username).fill(viewing.username);
  await owner.getByLabel(text.add.role).selectOption("viewer");
  await owner.getByRole("button", { name: text.add.submit }).click();
  const added = members.locator(`[data-member="${viewing.username}"]`);
  await expect(added).toHaveAttribute("data-role", "viewer");
  await expect(added).toContainText(viewing.displayName);
  await expect(owner.getByRole("alert")).toHaveCount(0);
  await expect(owner.getByLabel(text.add.username)).toHaveValue("");

  // The new member, in a browser of its own: the score is on /, and opens.
  const viewer = await loggedIn(browser, viewing);
  const viewerErrors = pageErrors(viewer);
  const listed = viewer.getByRole("link").filter({ has: viewer.getByText(title, { exact: true }) });
  await expect(listed).toContainText(strings.home.roles.viewer);
  await listed.click();
  await expect(viewer).toHaveURL(`/scores/${id}`);
  await drawn(viewer);
  expect((await viewer.evaluate(() => window.__studioTest!.scoreJson()))?.title).toBe(title);

  // Its settings page lists the members, with nothing to manage them; it can leave.
  await viewer.goto(`/scores/${id}/settings`);
  const seen = viewer.getByRole("region", { name: text.title });
  await expect(seen.locator("[data-member]")).toHaveCount(2);
  await expect(seen.getByRole("combobox")).toHaveCount(0);
  await expect(viewer.getByRole("button", { name: text.add.submit })).toHaveCount(0);
  await expect(viewer.getByRole("region", { name: strings.settings.link.title })).toHaveCount(0);
  await viewer.getByRole("button", { name: text.leave.action }).click();
  await viewer.getByRole("button", { name: text.leave.confirm, exact: true }).click();
  await expect(viewer).toHaveURL("/");
  await expect(viewer.getByText(title, { exact: true })).toHaveCount(0);

  await owner.reload();
  await expect(members.locator("[data-member]")).toHaveCount(1);
  expect(ownerErrors).toEqual([]);
  expect(viewerErrors).toEqual([]);
});
