// Recognizing images of a TAB (#64; docs/spec/phrases.md, sections 4 and 7): uploaded from the
// library, the review page opens the result in the phrase editor beside the image and what was
// left out; edited, it is saved as a phrase and the recognition goes with its image, or discarded.
// A tuning not understood is warned of and chosen by hand. On a phone the review page only shows.
// The server calls the stand-in recognizer (e2e/environment.ts), told which fixture to answer.
import { tuningFor } from "@studio/score-model";

import { strings } from "../src/strings";
import { ADMIN } from "./environment";
import { beatsIn, cursorOf, loggedIn, logInFromStart, originalShown, pageErrors, recognizeImage, runName, scoreOf } from "./pages";
import { type BrowserContextOptions, expect, type Page, test } from "./test";

const text = strings.recognition;

/** A phone held upright (the Browser pane's mobile preset): narrower than 768 px, touch, no fine pointer. */
const PHONE: BrowserContextOptions = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true };

/** The name the save dialog starts with: the day of the recognition. */
const DEFAULT_NAME = new RegExp(`^${text.defaultName(String.raw`\d{4}-\d{2}-\d{2}`)}$`);

/** The fret on the cursor's string of the beat the cursor is on, in the editor. */
async function fretAtCursor(page: Page): Promise<number | undefined> {
  const cursor = (await cursorOf(page))!;
  const beat = beatsIn(await scoreOf(page), 0, 0).find((each) => each.id === cursor.beatId);
  return beat?.notes[`s${cursor.line}`]?.fret;
}

/** Save the result as a phrase of this name: back in the library, which lists it. Its id. */
async function saveAs(page: Page, name: string): Promise<string> {
  await page.locator("[data-save-phrase]").click();
  const dialog = page.getByRole("dialog", { name: text.saveDialog.title });
  await expect(dialog.getByLabel(text.saveDialog.name)).toHaveValue(DEFAULT_NAME);
  await dialog.getByLabel(text.saveDialog.name).fill(name);
  await dialog.getByRole("button", { name: text.saveDialog.save }).click();
  await expect(page).toHaveURL("/phrases");
  const link = page.getByRole("link", { name, exact: true });
  await expect(link).toBeVisible();
  return (await link.getAttribute("href"))!.split("/").at(-1)!;
}

/** The recognition and its image are gone. */
async function gone(page: Page, id: string): Promise<void> {
  expect((await page.request.get(`/api/recognitions/${id}`)).status()).toBe(404);
  expect((await page.request.get(`/api/recognitions/${id}/images/1`)).status()).toBe(404);
}

test("the library's picker takes several images of any type a phone offers, camera or photos alike", async ({ page }) => {
  await logInFromStart(page, ADMIN);
  await page.goto("/phrases");
  const input = page.locator("[data-recognize-input]");
  await expect(input).toHaveAttribute("type", "file");
  await expect(input).toHaveAttribute("accept", "image/*");
  await expect(input).toHaveAttribute("multiple", "");
  expect(await input.getAttribute("capture")).toBeNull();
  await expect(page.getByRole("button", { name: strings.phrases.recognize })).toBeVisible();
});

test("an image uploaded is reviewed beside the result and what was left out, a fret changed, and saved as a phrase: the image is gone", async ({ page }) => {
  const errors = pageErrors(page);
  await logInFromStart(page, ADMIN);
  const id = await recognizeImage(page, "grace-and-strokes");
  await originalShown(page);
  await expect(page.locator('[data-skipped-item="grace_notes"]')).toBeVisible();
  await expect(page.locator("[data-save-phrase]")).toBeVisible();

  const before = await fretAtCursor(page);
  const fret = before === 9 ? 8 : 9;
  await page.keyboard.press(String(fret));
  expect(await fretAtCursor(page)).toBe(fret);
  await expect(page.locator("[data-edited]")).toBeVisible();
  const edited = await scoreOf(page);

  const name = runName("辨識的樂句");
  const phraseId = await saveAs(page, name);
  await gone(page, id);
  await expect(page.locator(`[data-recognition="${id}"]`)).toHaveCount(0);

  // The phrase holds the result as it was edited.
  await page.goto(`/phrases/${phraseId}`);
  await expect(page.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  const saved = await scoreOf(page);
  expect(saved.bars.map((bar) => beatsIn(saved, 0, saved.bars.indexOf(bar)).map((beat) => beat.notes))).toEqual(
    edited.bars.map((bar) => beatsIn(edited, 0, edited.bars.indexOf(bar)).map((beat) => beat.notes)),
  );
  expect(errors).toEqual([]);
});

test("a recognition discarded is gone with its image", async ({ page }) => {
  const errors = pageErrors(page);
  await logInFromStart(page, ADMIN);
  const id = await recognizeImage(page, "six-strings");
  await page.locator("[data-discard]").click();
  const question = page.getByRole("dialog", { name: text.discardDialog.title });
  await question.getByRole("button", { name: text.discardDialog.confirm }).click();
  await expect(page).toHaveURL("/phrases");
  await gone(page, id);
  await expect(page.locator(`[data-recognition="${id}"]`)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a tuning not understood is warned of; drop D chosen by hand is the tuning of the phrase saved", async ({ page }) => {
  const errors = pageErrors(page);
  await logInFromStart(page, ADMIN);
  await recognizeImage(page, "tuning-unrecognized");
  const warning = page.locator('[data-tuning-note="warning"]');
  await expect(warning).toContainText("Standard, down 1/2 step");
  await expect(page.locator('[data-skipped-item="tuning_unrecognized"]')).toBeVisible();

  await warning.getByRole("button", { name: text.chooseTuning }).click();
  const tuning = page.locator("[data-part-tuning]");
  await tuning.getByLabel(strings.score.parts.tuning).selectOption("drop");
  await tuning.getByRole("button", { name: strings.score.parts.apply }).click();
  await expect.poll(async () => (await scoreOf(page)).parts[0]!.tuning).toEqual(tuningFor("drop", 6));

  const phraseId = await saveAs(page, runName("手動調弦"));
  const phrase = await page.request.get(`/api/phrases/${phraseId}`);
  expect(((await phrase.json()) as { fragment: { tuning: number[] } }).fragment.tuning).toEqual(tuningFor("drop", 6));
  expect(errors).toEqual([]);
});

test("closing the review page with a change not saved as a phrase asks first", async ({ page }) => {
  const errors = pageErrors(page);
  await logInFromStart(page, ADMIN);
  await recognizeImage(page, "six-strings");
  await page.keyboard.press("7");
  await expect(page.locator("[data-edited]")).toBeVisible();
  const asked = page.waitForEvent("dialog", { timeout: 10_000 });
  await page.close({ runBeforeUnload: true });
  const dialog = await asked;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  expect(page.isClosed()).toBe(false);
  expect(errors).toEqual([]);
});

test("on a phone an image is uploaded and its result looked at, not changed nor saved; on a computer the same recognition is saved", async ({ browser }) => {
  const phone = await loggedIn(browser, ADMIN, PHONE);
  const phoneErrors = pageErrors(phone);
  await phone.goto("/phrases");
  await expect(phone.getByRole("button", { name: strings.phrases.recognize })).toBeVisible();
  const id = await recognizeImage(phone, "grace-and-strokes");
  await expect(phone.locator('main[data-view="read"]')).toBeVisible();
  await originalShown(phone);
  await expect(phone.locator('[data-skipped-item="grace_notes"]')).toBeVisible();
  await expect(phone.locator("[data-desktop-only]")).toHaveText(text.desktopOnly);
  await expect(phone.getByRole("button", { name: text.save })).toHaveCount(0);
  await expect(phone.getByRole("button", { name: text.discard })).toHaveCount(0);
  const before = await scoreOf(phone);
  await phone.locator("[data-scroller]").focus();
  await phone.keyboard.press("9");
  await phone.keyboard.press("Delete");
  expect(await scoreOf(phone)).toEqual(before);
  // Still waiting in the library for a computer.
  await phone.goto("/phrases");
  await expect(phone.locator(`[data-recognition="${id}"]`)).toBeVisible();

  const computer = await loggedIn(browser, ADMIN);
  const errors = pageErrors(computer);
  await computer.goto(`/recognitions/${id}`);
  await expect(computer.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await saveAs(computer, runName("手機上傳的樂句"));
  await gone(computer, id);
  expect(phoneErrors).toEqual([]);
  expect(errors).toEqual([]);
});
