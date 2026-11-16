// Deleting a score (#15; docs/spec/accounts.md, section 8): its Owner deletes it on the settings
// page, after a dialog asks; it leaves "my scores" for the "deleted" block of `/`, from where the
// Owner restores it. Accounts of the test's own: the "deleted" block lists every score its Owner
// deleted, so every run, retry and browser makes its Owner anew.
import { expect, test } from "@playwright/test";

import { strings } from "../src/strings";
import { loggedIn, pageErrors, seedAccount, seedScore } from "./pages";

const text = strings.settings.delete;
const home = strings.home;

test("an Owner deletes a score on its settings page, finds it in the deleted block of /, restores it, and it is back among the scores", async ({ browser }, testInfo) => {
  const run = `${testInfo.project.name.slice(0, 4)}-${Date.now().toString(36)}`;
  const account = (name: string, displayName: string) => ({ username: `e2e-${name}-${run}`, displayName, password: "e2e delete password", isAdmin: false, mustChangePassword: false });
  const owning = account("del-own", "刪除的擁有者");
  const editing = account("del-edit", "刪除的編輯者");
  seedAccount(owning);
  seedAccount(editing);
  const title = `刪除 ${run}`;
  const id = seedScore({ title, owner: owning.username, members: [{ username: editing.username, role: "editor" }] });

  // An Editor's settings page has nothing to delete the score with, and its `/` no deleted block.
  const editor = await loggedIn(browser, editing);
  const editorErrors = pageErrors(editor, [{ status: 404, path: `/api/scores/${id}` }]);
  await expect(editor.getByText(title, { exact: true })).toBeVisible();
  await expect(editor.getByRole("region", { name: home.deleted.title })).toHaveCount(0);
  await editor.goto(`/scores/${id}/settings`);
  await expect(editor.getByRole("region", { name: strings.settings.members.title })).toBeVisible();
  await expect(editor.getByRole("region", { name: text.title })).toHaveCount(0);

  const owner = await loggedIn(browser, owning);
  const ownerErrors = pageErrors(owner);
  const listed = owner.getByRole("link").filter({ has: owner.getByText(title, { exact: true }) });
  const deleted = owner.getByRole("region", { name: home.deleted.title });
  await expect(listed).toHaveCount(1);
  await expect(deleted).toHaveCount(0);

  // The dialog asks first: cancelled, nothing is deleted.
  await owner.goto(`/scores/${id}/settings`);
  await owner.getByRole("region", { name: text.title }).getByRole("button", { name: text.action }).click();
  const dialog = owner.getByRole("dialog", { name: text.title });
  await expect(dialog).toContainText(text.message(title));
  await dialog.getByRole("button", { name: text.cancel, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(owner).toHaveURL(`/scores/${id}/settings`);

  await owner.getByRole("region", { name: text.title }).getByRole("button", { name: text.action }).click();
  await owner.getByRole("dialog", { name: text.title }).getByRole("button", { name: text.confirm, exact: true }).click();

  // Back on `/`: out of the scores, in the deleted block.
  await expect(owner).toHaveURL("/");
  await expect(deleted.locator(`[data-deleted="${id}"]`)).toContainText(title);
  await expect(listed).toHaveCount(0);

  // The Editor no longer finds it: not on `/`, and its page is the 404 page.
  await editor.goto("/");
  await expect(editor.getByRole("heading", { name: home.title })).toBeVisible();
  await expect(editor.getByText(title, { exact: true })).toHaveCount(0);
  await expect(editor.getByRole("region", { name: home.deleted.title })).toHaveCount(0);
  await editor.goto(`/scores/${id}/settings`);
  await expect(editor.getByRole("heading", { name: strings.notFound.title })).toBeVisible();

  await deleted.getByRole("button", { name: home.deleted.restoreOf(title) }).click();

  // Back among the scores, for its Owner and for the Editor; the block, now empty, is gone.
  await expect(listed).toHaveCount(1);
  await expect(listed).toContainText(home.roles.owner);
  await expect(deleted).toHaveCount(0);
  await editor.goto("/");
  await expect(editor.getByRole("link").filter({ has: editor.getByText(title, { exact: true }) })).toContainText(home.roles.editor);
  await listed.click();
  await expect(owner).toHaveURL(`/scores/${id}`);

  expect(ownerErrors).toEqual([]);
  expect(editorErrors).toEqual([]);
});
