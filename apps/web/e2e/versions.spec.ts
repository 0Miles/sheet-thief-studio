// A score's versions (#67; docs/spec/collab.md, section 8): an Editor types a few notes and
// leaves, which makes a version; on the versions page the preview draws what the score held then,
// not what it holds now. An Editor names a version and saves the score as a named one; a Viewer
// only lists and previews; anyone else gets the 404 page.
import type { Page } from "@playwright/test";
import type { ScoreJSON } from "@studio/score-model";

import { strings } from "../src/strings";
import { ADMIN, EDITOR, OUTSIDER, VIEWER } from "./environment";
import { beatsIn, loggedIn, openScore, pageErrors, seedScore, synced, typeBeats } from "./pages";
import { expect, test } from "./test";

const text = strings.versions;

/** The frets of the first voice of the first bar of the first part. */
const fretsOf = (score: ScoreJSON | null) => (score === null ? null : beatsIn(score, 0, 0).map((beat) => beat.notes.s1?.fret));

/** How many versions the score has, as the API lists them to this page's account. */
async function versionCount(page: Page, id: string): Promise<number> {
  const answer = await page.request.get(`/api/scores/${id}/versions`);
  return ((await answer.json()) as { versions: unknown[] }).versions.length;
}

/** Type these frets at the end of the first bar, then leave by the score's link to its versions: the last member leaving makes a version. */
async function typeAndLeave(page: Page, id: string, frets: number[], versionsBefore: number): Promise<void> {
  await openScore(page, id);
  // The end of the bar: after the beats typed in an earlier stay.
  await page.keyboard.press("End");
  await typeBeats(page, frets);
  await synced(page);
  await page.locator("[data-versions-link]").click();
  await expect(page).toHaveURL(`/scores/${id}/versions`);
  await expect.poll(() => versionCount(page, id), { timeout: 15_000 }).toBe(versionsBefore + 1);
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
  await editor.reload();
  const items = editor.locator("[data-version]");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toHaveAttribute("data-reason", "last_disconnect");
  await expect(items.first()).toContainText(text.reasons.last_disconnect);

  // The older one draws the score as it was then; the latest one, as it is now.
  expect(fretsOf(await previewVersion(editor, 1))).toEqual([5, 7]);
  expect(fretsOf(await previewVersion(editor, 0))).toEqual([5, 7, 9]);
  await expect(editor.locator('[data-player="paused"]')).toBeVisible({ timeout: 30_000 });

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
  expect(viewerErrors).toEqual([]);

  // Anyone else: no such page.
  const outsider = await loggedIn(browser, OUTSIDER);
  pageErrors(outsider);
  await outsider.goto(`/scores/${id}/versions`);
  await expect(outsider.getByRole("heading", { name: strings.notFound.title })).toBeVisible();
});
