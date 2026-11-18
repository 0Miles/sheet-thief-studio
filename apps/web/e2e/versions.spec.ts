// A score's versions (#67, #68; docs/spec/collab.md, section 8): an Editor types a few notes and
// leaves, which makes a version; on the versions page the preview draws what the score held then,
// not what it holds now. An Editor names a version, saves the score as a named one, and restores
// one in place, the score kept open under the versions page: back on the score it is the version,
// Ctrl+Z takes the restore back, and the list has the version made before it. A Viewer only lists
// and previews; anyone else gets the 404 page.
import type { Page } from "@playwright/test";
import type { ScoreJSON } from "@studio/score-model";

import { strings } from "../src/strings";
import { ADMIN, EDITOR, OUTSIDER, VIEWER } from "./environment";
import { beatsIn, drawn, loggedIn, openScore, pageErrors, scoreOf, seedScore, synced, typeBeats } from "./pages";
import { expect, test } from "./test";

const text = strings.versions;

/** The frets of the first voice of the first bar of the first part. */
const fretsOf = (score: ScoreJSON | null) => (score === null ? null : beatsIn(score, 0, 0).map((beat) => beat.notes.s1?.fret));

/** How many versions the score has, as the API lists them to this page's account. */
async function versionCount(page: Page, id: string): Promise<number> {
  const answer = await page.request.get(`/api/scores/${id}/versions`);
  return ((await answer.json()) as { versions: unknown[] }).versions.length;
}

/** Type these frets at the end of the first bar, once the score is open. */
async function typeAtEnd(page: Page, frets: number[]): Promise<void> {
  // The end of the bar: after the beats typed before.
  await page.keyboard.press("End");
  await typeBeats(page, frets);
  await synced(page);
}

/**
 * Type these frets at the end of the first bar, then leave the score for the home page: the last
 * member leaving makes a version. Not by the link to the versions page, which keeps the score open
 * under it (docs/spec/collab.md, 8.5).
 */
async function typeAndLeave(page: Page, id: string, frets: number[], versionsBefore: number): Promise<void> {
  await openScore(page, id);
  await typeAtEnd(page, frets);
  await page.goto("/");
  await expect.poll(() => versionCount(page, id), { timeout: 15_000 }).toBe(versionsBefore + 1);
}

/** The score's link to its versions, which keeps the score open under the page. */
async function toVersions(page: Page, id: string): Promise<void> {
  await page.locator("[data-versions-link]").click();
  await expect(page).toHaveURL(`/scores/${id}/versions`);
  await expect(page.locator("[data-version]").first()).toBeVisible();
}

/** Preview this version (by its place in the list, the latest first) and wait until it is drawn. */
async function previewVersion(page: Page, index: number): Promise<ScoreJSON | null> {
  const item = page.locator("[data-version]").nth(index);
  const versionId = await item.getAttribute("data-version-id");
  await item.locator("[data-preview]").click();
  const pane = page.locator("[data-preview-pane]");
  await expect(pane).toHaveAttribute("data-shown", versionId!, { timeout: 30_000 });
  await expect(pane).toHaveAttribute("data-ready", "true");
  return page.evaluate(() => window.__studioTest!.scoreJson());
}

test("an Editor's notes, made a version as they leave, are what its preview draws; they name it and save a named one; a Viewer previews only; anyone else gets 404", async ({ browser }) => {
  const id = seedScore({
    title: "版本測試",
    owner: ADMIN.username,
    members: [
      { username: EDITOR.username, role: "editor" },
      { username: VIEWER.username, role: "viewer" },
    ],
  });
  const editor = await loggedIn(browser, EDITOR);
  const errors = pageErrors(editor);

  // Two stays, each ending in a version: 5 and 7 first, then 9 after them.
  await typeAndLeave(editor, id, [5, 7], 0);
  await typeAndLeave(editor, id, [9], 1);
  await editor.goto(`/scores/${id}/versions`);
  const items = editor.locator("[data-version]");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toHaveAttribute("data-reason", "last_disconnect");
  await expect(items.first()).toContainText(text.reasons.last_disconnect);

  // The older one draws the score as it was then; the latest one, as it is now.
  expect(fretsOf(await previewVersion(editor, 1))).toEqual([5, 7]);
  expect(fretsOf(await previewVersion(editor, 0))).toEqual([5, 7, 9]);
  // The preview's player: the score's own is open under the page, hidden.
  await expect(editor.locator('[data-preview-pane] [data-player="paused"]')).toBeVisible({ timeout: 30_000 });

  // Naming the older one.
  const older = items.nth(1);
  await older.locator("[data-rename]").click();
  await older.locator("[data-naming]").getByRole("textbox").fill("只有兩個音");
  await older.locator("[data-naming]").getByRole("button", { name: text.saveName }).click();
  await expect(older.locator("[data-version-name]")).toContainText("只有兩個音");
  await expect(older).toHaveAttribute("data-named", "true");

  // Saving the score as it is now, with a name: it heads the list.
  await editor.locator("[data-save-version]").getByLabel(text.name).fill("排練前");
  await editor.locator("[data-save-version]").getByRole("button", { name: text.save.submit }).click();
  await expect(items).toHaveCount(3);
  await expect(items.first()).toHaveAttribute("data-reason", "manual");
  await expect(items.first().locator("[data-version-name]")).toContainText("排練前");
  expect(fretsOf(await previewVersion(editor, 0))).toEqual([5, 7, 9]);
  expect(errors).toEqual([]);

  // A Viewer lists and previews, and has nothing to name or save with.
  const viewer = await loggedIn(browser, VIEWER);
  const viewerErrors = pageErrors(viewer);
  await viewer.goto(`/scores/${id}/versions`);
  await expect(viewer.locator("[data-version]")).toHaveCount(3);
  expect(fretsOf(await previewVersion(viewer, 2))).toEqual([5, 7]);
  await expect(viewer.locator("[data-rename]")).toHaveCount(0);
  await expect(viewer.locator("[data-save-version]")).toHaveCount(0);
  await expect(viewer.locator("[data-restore]")).toHaveCount(0);
  expect(viewerErrors).toEqual([]);

  // Anyone else: no such page.
  const outsider = await loggedIn(browser, OUTSIDER);
  pageErrors(outsider);
  await outsider.goto(`/scores/${id}/versions`);
  await expect(outsider.getByRole("heading", { name: strings.notFound.title })).toBeVisible();
});

test("an Editor restores an older version in place: back on the score it is the version, Ctrl+Z takes it back, and the list has the version made before it", async ({ browser }) => {
  const id = seedScore({ title: "還原測試", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }] });
  const editor = await loggedIn(browser, EDITOR);
  const errors = pageErrors(editor);
  await typeAndLeave(editor, id, [5, 7], 0);
  await typeAndLeave(editor, id, [9], 1);

  // More typed since the latest version, then the versions page by the score's link. The Owner,
  // on the score meanwhile, sees the Editor there, reading with no cursor, while on that page.
  const owner = await loggedIn(browser, ADMIN);
  pageErrors(owner);
  await openScore(owner, id);
  await openScore(editor, id);
  await typeAtEnd(editor, [3]);
  expect(fretsOf(await scoreOf(editor))).toEqual([5, 7, 9, 3]);
  const seen = owner.locator("[data-member]", { hasText: EDITOR.displayName });
  await expect(seen).toHaveAttribute("data-mode", "edit");
  await toVersions(editor, id);
  await expect(seen).toHaveAttribute("data-mode", "read");
  const items = editor.locator("[data-version]");
  await expect(items).toHaveCount(2);

  // The older one, the question answered: the score as it was then.
  await items.nth(1).locator("[data-restore]").click();
  const question = editor.getByRole("dialog", { name: text.restore.title });
  await expect(question).toContainText(text.reasons.before_restore);
  await expect(question).toContainText("還沒同步到這裡的小節與聲部則會保留");
  await question.getByRole("button", { name: text.restore.confirm }).click();
  await expect(editor).toHaveURL(`/scores/${id}`);
  await drawn(editor);
  await expect.poll(async () => fretsOf(await scoreOf(editor))).toEqual([5, 7]);
  await synced(editor);
  await expect.poll(async () => fretsOf(await scoreOf(owner))).toEqual([5, 7]);
  await expect(seen).toHaveAttribute("data-mode", "edit");

  // One undo step: the score as it was before the restore, and again the version with redo.
  await editor.keyboard.press("Control+z");
  await expect.poll(async () => fretsOf(await scoreOf(editor))).toEqual([5, 7, 9, 3]);
  await editor.keyboard.press("Control+y");
  await expect.poll(async () => fretsOf(await scoreOf(editor))).toEqual([5, 7]);
  await synced(editor);

  // The version made before the restore heads the list, holding what the score held then.
  await toVersions(editor, id);
  await expect(items).toHaveCount(3);
  await expect(items.first()).toHaveAttribute("data-reason", "before_restore");
  await expect(items.first()).toContainText(text.reasons.before_restore);
  expect(fretsOf(await previewVersion(editor, 0))).toEqual([5, 7, 9, 3]);
  expect(errors).toEqual([]);
});

test("an Editor on a device that cannot be typed on restores in the Read view, and a key undoes it there", async ({ browser }) => {
  const id = seedScore({ title: "平板還原", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }] });
  const editor = await loggedIn(browser, EDITOR);
  pageErrors(editor);
  await typeAndLeave(editor, id, [4], 0);
  await openScore(editor, id);
  await typeAtEnd(editor, [6]);
  await editor.goto("/");

  // A window narrower than 1024 px: the Read view (docs/spec/views.md, section 1).
  const tablet = await loggedIn(browser, EDITOR, { viewport: { width: 900, height: 900 } });
  const errors = pageErrors(tablet);
  await openScore(tablet, id);
  await expect(tablet.locator("main[data-view]")).toHaveAttribute("data-view", "read");
  expect(fretsOf(await scoreOf(tablet))).toEqual([4, 6]);
  await toVersions(tablet, id);
  const items = tablet.locator("[data-version]");
  await items.last().locator("[data-restore]").click();
  await tablet.getByRole("dialog", { name: text.restore.title }).getByRole("button", { name: text.restore.confirm }).click();
  await expect(tablet).toHaveURL(`/scores/${id}`);
  await expect.poll(async () => fretsOf(await scoreOf(tablet))).toEqual([4]);
  await expect(tablet.locator("main[data-view]")).toHaveAttribute("data-view", "read");

  await tablet.keyboard.press("Control+z");
  await expect.poll(async () => fretsOf(await scoreOf(tablet))).toEqual([4, 6]);
  // No cursor there: a note key changes nothing.
  await tablet.keyboard.press("7");
  expect(await tablet.evaluate(() => window.__studioTest!.cursor())).toBeNull();
  await tablet.keyboard.press("Control+y");
  await expect.poll(async () => fretsOf(await scoreOf(tablet))).toEqual([4]);
  await synced(tablet);
  expect(errors).toEqual([]);
});
