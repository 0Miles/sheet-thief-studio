// Bars of a score saved as a phrase (#55; docs/spec/phrases.md, section 3): a Viewer in the
// read-only edit view saves a range of bars, which the library then lists and the phrase editor
// opens as those bars; a range of beats cannot be saved, and a guest's Read view has no such action.
import { fragmentOfBars, scoreToFragment } from "@studio/score-model";

import { strings } from "../src/strings";
import { ADMIN, VIEWER } from "./environment";
import { beatsIn, loggedIn, openScore, pageErrors, runName, scoreOf, seedScore, synced } from "./pages";
import { expect, type Page, test } from "./test";

const text = strings.savePhrase;

/** The frets of the first string, beat by beat, in the first voice of a bar of the first part. */
async function fretsIn(page: Page, bar: number): Promise<(number | undefined)[]> {
  return beatsIn(await scoreOf(page), 0, bar).map((beat) => beat.notes.s1?.fret);
}

/** A score the Viewer is a member of, with the Owner's notes typed in bar by bar: one list of frets a bar, from the first. */
async function scoreWithNotes(browser: Parameters<typeof loggedIn>[0], title: string, bars: number[][]): Promise<string> {
  const id = seedScore({ title, owner: ADMIN.username, members: [{ username: VIEWER.username, role: "viewer" }], bars: 4 });
  const owner = await loggedIn(browser, ADMIN);
  const errors = pageErrors(owner);
  await openScore(owner, id);
  for (const [index, frets] of bars.entries()) {
    if (index > 0) await owner.keyboard.press("Control+ArrowRight");
    for (const [at, fret] of frets.entries()) {
      if (at > 0) await owner.keyboard.press("ArrowRight");
      await owner.keyboard.press(String(fret));
    }
  }
  for (const [index, frets] of bars.entries()) expect(await fretsIn(owner, index)).toEqual(frets);
  await synced(owner);
  expect(errors).toEqual([]);
  await owner.context().close();
  return id;
}

test("a Viewer saves bars 2–3 as a phrase: the library lists it, and it opens as those two bars", async ({ browser }) => {
  const title = runName("存成樂句");
  const id = await scoreWithNotes(browser, title, [[1], [3], [5, 7], [9]]);
  const page = await loggedIn(browser, VIEWER);
  const errors = pageErrors(page);
  await openScore(page, id);
  await expect(page.locator("main")).toHaveAttribute("data-view", "readOnlyEdit");
  const save = page.locator("[data-save-phrase]");
  // Nothing selected yet.
  await expect(save).toBeDisabled();

  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("Control+Shift+ArrowRight");
  await expect(save).toBeEnabled();
  const score = await scoreOf(page);
  const expected = fragmentOfBars(score, { partId: score.parts[0]!.id, anchorBarId: score.bars[1]!.id, focusBarId: score.bars[2]!.id })!;
  await save.click();

  const dialog = page.getByRole("dialog", { name: text.title });
  const field = dialog.getByLabel(text.name);
  await expect(field).toHaveValue(`${title} 第 2–3 小節`);
  const name = runName("檢視者的樂句");
  await field.fill(name);
  await dialog.getByRole("button", { name: text.save }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText(text.saved(name))).toBeVisible();
  // Saving changed nothing of the score.
  expect(await scoreOf(page)).toEqual(score);

  await page.goto("/phrases");
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page).toHaveURL(/\/phrases\/[0-9a-f-]{36}$/);
  await expect(page.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  const phrase = await scoreOf(page);
  expect(phrase.bars).toHaveLength(2);
  expect(await fretsIn(page, 0)).toEqual([3]);
  expect(await fretsIn(page, 1)).toEqual([5, 7]);
  expect(scoreToFragment(phrase)).toEqual(expected);
  expect(errors).toEqual([]);
});

test("a range of beats cannot be saved as a phrase, and a guest's Read view has no such action", async ({ browser }) => {
  const id = await scoreWithNotes(browser, runName("拍點範圍"), [[1, 2, 3]]);
  const page = await loggedIn(browser, VIEWER);
  const errors = pageErrors(page);
  await openScore(page, id);
  const save = page.locator("[data-save-phrase]");

  await page.keyboard.press("Shift+ArrowRight");
  await expect(page.locator("[data-selection]")).toHaveCount(1);
  await expect(save).toBeDisabled();
  await expect(page.locator("[data-save-phrase-hint]")).toHaveAttribute("title", text.barsOnly);
  // Extended past its bar, the range of beats becomes one of bars (from its bar on), which may be.
  await page.keyboard.press("Control+Shift+ArrowRight");
  await expect(save).toBeEnabled();
  expect(errors).toEqual([]);

  const owner = await loggedIn(browser, ADMIN);
  const made = await owner.request.post(`/api/scores/${id}/link`, { headers: { origin: new URL(owner.url()).origin } });
  expect(made.status()).toBe(200);
  const { token } = (await made.json()) as { token: string };
  // A browser of its own, never logged in, on a desktop that could be typed on.
  const guest = await (await browser.newContext()).newPage();
  const guestErrors = pageErrors(guest);
  await guest.goto(`/s/${token}`);
  await expect(guest.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(guest.locator("main")).toHaveAttribute("data-view", "read");
  await expect(guest.locator("[data-save-phrase]")).toHaveCount(0);
  await expect(guest.getByRole("button", { name: text.open })).toHaveCount(0);
  expect(guestErrors).toEqual([]);
});
