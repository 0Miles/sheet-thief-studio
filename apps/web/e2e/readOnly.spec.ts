// A score the server cannot bring to its schema (#109; docs/spec/collab.md, 2.1; docs/spec/views.md,
// section 10): it takes nothing any connection sends to it, and tells every connection why. An
// Editor's page opens it read-only, saying why, rather than let them type what the server drops.
// Accounts of the test's own, so that every run, retry and browser makes them anew.
import { strings } from "../src/strings";
import { loggedIn, openScore, pageErrors, scoreOf, seedAccount, seedScore } from "./pages";
import { expect, type TestInfo, test } from "./test";

const text = strings.score;

function accountsFor(testInfo: TestInfo) {
  const run = `${testInfo.project.name.slice(0, 4)}-${Date.now().toString(36)}`;
  const account = (name: string, displayName: string) => {
    const made = { username: `e2e-${name}-${run}`, displayName, password: "e2e read-only password", isAdmin: false, mustChangePassword: false };
    seedAccount(made);
    return made;
  };
  return { run, account };
}

test("an Editor opens a score the server has no migration for read-only, told why; a Viewer is told nothing new", async ({ browser }, testInfo) => {
  const { run, account } = accountsFor(testInfo);
  const owning = account("ro-own", "唯讀團譜的擁有者");
  const editing = account("ro-edit", "唯讀團譜的編輯者");
  const viewing = account("ro-view", "唯讀團譜的檢視者");
  // Schema 0: no published step leads on from it, so the server freezes it as it loads it.
  const id = seedScore({
    title: `缺少遷移 ${run}`,
    owner: owning.username,
    members: [
      { username: editing.username, role: "editor" },
      { username: viewing.username, role: "viewer" },
    ],
    schemaVersion: 0,
  });
  const editor = await loggedIn(browser, editing);
  const viewer = await loggedIn(browser, viewing);
  const errors = [pageErrors(editor), pageErrors(viewer)];

  await openScore(editor, id);
  await expect(editor.locator('[data-view="readOnlyEdit"]')).toBeVisible();
  const notice = editor.locator(".score__notice");
  await expect(notice).toContainText(text.readOnly.missingMigration);

  // A key that would change the score changes nothing, and says why again.
  const before = await scoreOf(editor);
  await notice.getByRole("button", { name: text.dismiss }).click();
  await expect(notice).toHaveCount(0);
  await editor.keyboard.press("7");
  await expect(notice).toContainText(text.readOnly.missingMigration);
  expect(await scoreOf(editor)).toEqual(before);
  await expect(editor.locator('[data-view="readOnlyEdit"]')).toBeVisible();

  // A Viewer reads only anyway: the notice tells them nothing.
  await openScore(viewer, id);
  await expect(viewer.locator('[data-view="readOnlyEdit"]')).toBeVisible();
  await expect(viewer.locator(".score__notice")).toHaveCount(0);
  expect(errors.flat()).toEqual([]);
});
