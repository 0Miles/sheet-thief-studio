// Offline, reconnecting, and rights that change while a score is open (#35; docs/spec/collab.md,
// section 7; docs/spec/views.md, section 10). A page goes on offline, and Yjs merges what it typed
// once it is back; a reconnection that finds the member's rights changed drops the page's
// document. Accounts of the test's own: their roles and sessions change, so every run, retry and
// browser makes them anew.
import { expect, type Page, test, type TestInfo } from "./test";

import { strings } from "../src/strings";
import { beatsIn, cursorOf, drawn, loggedIn, openScore, pageErrors, type Refusal, scoreOf, seedAccount, seedScore, typeBeats } from "./pages";

const text = strings.score;

/** An empty bar of a new score (the fourth), its first string: where the tests type. */
const BAR = 3;

function accountsFor(testInfo: TestInfo) {
  const run = `${testInfo.project.name.slice(0, 4)}-${Date.now().toString(36)}`;
  const account = (name: string, displayName: string) => {
    const made = { username: `e2e-${name}-${run}`, displayName, password: "e2e reconnect password", isAdmin: false, mustChangePassword: false };
    seedAccount(made);
    return made;
  };
  return { run, account };
}

/** From where the edit view starts (the first string of the first bar), to the append slot of the empty fourth bar. */
async function goToBar(page: Page): Promise<void> {
  for (let bar = 0; bar < BAR; bar++) await page.keyboard.press("ArrowRight");
}

/** The frets typed on the first string of the fourth bar, as the page holds the score. */
async function fretsOf(page: Page): Promise<number[]> {
  return beatsIn(await scoreOf(page), 0, BAR).map((beat) => beat.notes.s1?.fret ?? -1);
}

/** Call the API as the account logged in on the page, as its own pages do (the Origin is checked). */
async function api(page: Page, method: "PATCH" | "DELETE" | "POST", path: string, data?: unknown): Promise<void> {
  const origin = new URL(page.url()).origin;
  const response = await page.request.fetch(path, { method, data, headers: { origin } });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true);
}

async function accountIdOf(page: Page, scoreId: string, username: string): Promise<string> {
  const { members } = (await (await page.request.get(`/api/scores/${scoreId}/members`)).json()) as { members: { accountId: string; username: string }[] };
  return members.find((member) => member.username === username)!.accountId;
}

/** The ticket a reconnection asks for, refused: the browser logs it, as the test expects. */
const ticketRefused = (scoreId: string, status: number): Refusal => ({ status, path: `/api/scores/${scoreId}/collab-ticket` });

test("offline, a member keeps typing under a banner; back online, another member gets what was typed", async ({ browser }, testInfo) => {
  const { run, account } = accountsFor(testInfo);
  const owning = account("off-own", "離線的擁有者");
  const editing = account("off-edit", "離線的編輯者");
  const id = seedScore({ title: `離線 ${run}`, owner: owning.username, members: [{ username: editing.username, role: "editor" }] });
  const owner = await loggedIn(browser, owning);
  const editor = await loggedIn(browser, editing);
  const errors = [pageErrors(owner), pageErrors(editor)];
  await openScore(owner, id);
  await openScore(editor, id);
  await expect(owner.locator("[data-offline]")).toHaveCount(0);

  await owner.context().setOffline(true);
  await expect(owner.locator("[data-offline]")).toHaveText(text.offline);
  await expect(owner.locator('[data-sync="offline"]')).toBeVisible();
  await goToBar(owner);
  await typeBeats(owner, [3, 5]);
  expect(await fretsOf(owner)).toEqual([3, 5]);
  // Still offline: typing does not make it look as if it were sending.
  await expect(owner.locator('[data-sync="offline"]')).toBeVisible();
  await owner.waitForTimeout(500);
  expect(await fretsOf(editor)).toEqual([]);

  await owner.context().setOffline(false);
  await expect(owner.locator("[data-offline]")).toHaveCount(0);
  await expect(owner.locator('[data-sync="synced"]')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => fretsOf(editor), { timeout: 15_000 }).toEqual([3, 5]);
  expect(errors.flat()).toEqual([]);
});

test("closing a page with changes the server has not confirmed asks first", async ({ browser }, testInfo) => {
  const { run, account } = accountsFor(testInfo);
  const owning = account("unload-own", "離開前的擁有者");
  const id = seedScore({ title: `離開 ${run}`, owner: owning.username });
  const owner = await loggedIn(browser, owning);
  await openScore(owner, id);

  // Everything sent and confirmed: leaving is not held up.
  const holdsUp = () =>
    owner.evaluate(() => {
      const leaving = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(leaving);
      return leaving.defaultPrevented;
    });
  await goToBar(owner);
  await typeBeats(owner, [2]);
  await expect(owner.locator('[data-sync="synced"]')).toBeVisible();
  expect(await holdsUp()).toBe(false);

  const asked: string[] = [];
  owner.on("dialog", (dialog) => {
    asked.push(dialog.type());
    void dialog.dismiss();
  });
  await owner.context().setOffline(true);
  await expect(owner.locator("[data-offline]")).toBeVisible();
  await typeBeats(owner, [4]);
  await owner.close({ runBeforeUnload: true });
  await expect.poll(() => asked).toEqual(["beforeunload"]);
  // Dismissed: the page stays, with what was typed.
  expect(owner.isClosed()).toBe(false);
  expect(await fretsOf(owner)).toEqual([2, 4]);
});

test("an Editor made a Viewer while the score is open gets it anew, read-only, without what was typed after", async ({ browser }, testInfo) => {
  const { run, account } = accountsFor(testInfo);
  const owning = account("demote-own", "降級的擁有者");
  const editing = account("demote-edit", "被降級的編輯者");
  const id = seedScore({ title: `降級 ${run}`, owner: owning.username, members: [{ username: editing.username, role: "editor" }] });
  const owner = await loggedIn(browser, owning);
  const editor = await loggedIn(browser, editing);
  const errors = [pageErrors(owner), pageErrors(editor)];
  await openScore(owner, id);
  await openScore(editor, id);
  await expect(editor.locator('[data-view="editable"]')).toBeVisible();

  // Typed once the Owner has made it a Viewer, before the page hears of it: offline meanwhile.
  await editor.context().setOffline(true);
  await expect(editor.locator("[data-offline]")).toBeVisible();
  await api(owner, "PATCH", `/api/scores/${id}/members/${await accountIdOf(owner, id, editing.username)}`, { role: "viewer" });
  await goToBar(editor);
  await typeBeats(editor, [7, 8]);
  expect(await fretsOf(editor)).toEqual([7, 8]);

  await editor.context().setOffline(false);
  await expect(editor.locator('[data-view="readOnlyEdit"]')).toBeVisible({ timeout: 15_000 });
  await expect(editor.getByRole("status").filter({ hasText: text.roleChanged(strings.home.roles.viewer) })).toBeVisible();
  await drawn(editor);
  expect(await fretsOf(editor)).toEqual([]);
  expect(await fretsOf(owner)).toEqual([]);
  // Read-only now: a key that would change the score says so.
  await editor.keyboard.press("5");
  await expect(editor.getByRole("status").filter({ hasText: text.viewerCannotEdit })).toBeVisible();
  expect(await fretsOf(editor)).toEqual([]);
  expect(errors.flat()).toEqual([]);
});

test("a Viewer made an Editor gets the score anew, to type in; an Owner who hands the score over keeps typing", async ({ browser }, testInfo) => {
  const { run, account } = accountsFor(testInfo);
  const owning = account("up-own", "升級的擁有者");
  const viewing = account("up-view", "被升級的檢視者");
  const id = seedScore({ title: `升級 ${run}`, owner: owning.username, members: [{ username: viewing.username, role: "viewer" }] });
  const owner = await loggedIn(browser, owning);
  const viewer = await loggedIn(browser, viewing);
  const errors = [pageErrors(owner), pageErrors(viewer)];
  await openScore(owner, id);
  await openScore(viewer, id);
  await expect(viewer.locator('[data-view="readOnlyEdit"]')).toBeVisible();

  const viewerId = await accountIdOf(owner, id, viewing.username);
  await api(owner, "PATCH", `/api/scores/${id}/members/${viewerId}`, { role: "editor" });
  await expect(viewer.locator('[data-view="editable"]')).toBeVisible({ timeout: 15_000 });
  await expect(viewer.getByRole("status").filter({ hasText: text.roleChanged(strings.home.roles.editor) })).toBeVisible();
  await drawn(viewer);
  await goToBar(viewer);
  await typeBeats(viewer, [1]);
  await expect.poll(() => fretsOf(owner), { timeout: 15_000 }).toEqual([1]);

  // The Owner, now an Editor, stays on the same page and document, and is told.
  await api(owner, "POST", `/api/scores/${id}/transfer`, { accountId: viewerId });
  await expect(owner.getByRole("status").filter({ hasText: text.roleChanged(strings.home.roles.editor) })).toBeVisible({ timeout: 15_000 });
  await expect(owner.locator('[data-view="editable"]')).toBeVisible();
  await expect(owner.locator('[data-sync="synced"]')).toBeVisible();
  // Past the beat the Viewer typed, to the append slot after it.
  await goToBar(owner);
  await owner.keyboard.press("ArrowRight");
  expect(await cursorOf(owner)).toMatchObject({ at: "after" });
  await typeBeats(owner, [6]);
  await expect.poll(() => fretsOf(viewer), { timeout: 15_000 }).toEqual([1, 6]);
  expect(errors.flat()).toEqual([]);
});

test("a member removed, or whose score is deleted, while it is open gets the 404 page, told why", async ({ browser }, testInfo) => {
  const { run, account } = accountsFor(testInfo);
  const owning = account("gone-own", "移除的擁有者");
  const removing = account("gone-rm", "被移除的成員");
  const staying = account("gone-stay", "留下的成員");
  const id = seedScore({
    title: `移除 ${run}`,
    owner: owning.username,
    members: [
      { username: removing.username, role: "editor" },
      { username: staying.username, role: "viewer" },
    ],
  });
  const owner = await loggedIn(browser, owning);
  const removed = await loggedIn(browser, removing);
  const stayed = await loggedIn(browser, staying);
  const errors = [pageErrors(owner), pageErrors(removed, [ticketRefused(id, 404)]), pageErrors(stayed, [ticketRefused(id, 404)])];
  await openScore(removed, id);
  await openScore(stayed, id);

  await owner.goto("/");
  await api(owner, "DELETE", `/api/scores/${id}/members/${await accountIdOf(owner, id, removing.username)}`);
  await expect(removed.getByRole("heading", { name: strings.notFound.title })).toBeVisible({ timeout: 15_000 });
  await expect(removed.locator("[data-notice]")).toHaveText(text.removed);
  await expect(removed).toHaveURL(`/scores/${id}`);
  // The other member is not concerned.
  await expect(stayed.locator('[data-sync="synced"]')).toBeVisible();

  await api(owner, "DELETE", `/api/scores/${id}`);
  await expect(stayed.getByRole("heading", { name: strings.notFound.title })).toBeVisible({ timeout: 15_000 });
  await expect(stayed.locator("[data-notice]")).toHaveText(text.removed);
  expect(errors.flat()).toEqual([]);
});

test("a session ended elsewhere while a score is open leads to /login, told why, and back to the score after logging in", async ({ browser }, testInfo) => {
  const { run, account } = accountsFor(testInfo);
  const owning = account("ended-own", "登出的擁有者");
  const id = seedScore({ title: `登出 ${run}`, owner: owning.username });
  const here = await loggedIn(browser, owning);
  const elsewhere = await loggedIn(browser, owning);
  const errors = pageErrors(here, [{ status: 401, path: "/api/me" }, ticketRefused(id, 401)]);
  await openScore(here, id);

  await api(elsewhere, "POST", "/api/auth/logout-all");
  await expect(here).toHaveURL(/\/login\?redirect=/, { timeout: 15_000 });
  await expect(here.getByRole("status")).toHaveText(strings.login.expired);
  await here.getByLabel(strings.login.username).fill(owning.username);
  await here.getByLabel(strings.login.password).fill(owning.password);
  await here.getByRole("button", { name: strings.login.submit }).click();
  await expect(here).toHaveURL(`/scores/${id}`);
  await drawn(here);
  expect(errors).toEqual([]);
});
