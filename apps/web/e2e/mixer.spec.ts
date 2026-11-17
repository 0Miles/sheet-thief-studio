// The mixer (#33; docs/spec/playback.md, sections 1, 3 and 4): each member's own settings, kept in
// this browser; the selection played as a loop; the metronome and the count-in; and changes made
// while the score plays. How it sounds is for a person to judge (#41): here the settings, the
// positions and the states are checked.
import { expect, type Page, test } from "./test";

import { strings } from "../src/strings";
import { ADMIN, EDITOR } from "./environment";
import { barsShown, loggedIn, oneAfterAnother, openScore, pageErrors, recordBarsShown, scoreOf, seedScore, soundReady, untilShown } from "./pages";

const text = strings.score;

/** A score of a guitar and a bass, the Editor a member of it. */
function seed(bars?: number): string {
  return seedScore({ title: "混音測試", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], bars, parts: [{ name: "貝斯", kind: "fretted" }] });
}

async function openToPlay(page: Page, id: string): Promise<void> {
  await openScore(page, id);
  await soundReady(page);
}

/** The mixer at the side of the score, opened from the toolbar. */
async function openMixer(page: Page) {
  await page.locator("[data-toggle-mixer]").click();
  const mixer = page.locator("[data-mixer-panel]");
  await expect(mixer).toBeVisible();
  return mixer;
}

test("every setting is kept after a reload; the mix and the speed for this score only, the others for every score", async ({ browser }) => {
  const id = seed();
  const other = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  const [guitar, bass] = (await scoreOf(page)).parts;
  let mixer = await openMixer(page);
  await mixer.getByLabel(text.mixer.muteOf(bass!.name)).check();
  await mixer.getByLabel(text.mixer.soloOf(guitar!.name)).check();
  await mixer.getByLabel(text.mixer.volumeOf(guitar!.name)).fill("0.5");
  await mixer.getByLabel(text.mixer.speed).selectOption({ label: text.mixer.percent(0.75) });
  await mixer.getByLabel(text.mixer.metronome).check();
  await mixer.getByLabel(text.mixer.countIn).check();
  await mixer.getByLabel(text.mixer.whilePlaying).selectOption({ label: text.mixer.modes.b });

  // Opened again: the page loads anew.
  await openToPlay(page, id);
  mixer = await openMixer(page);
  await expect(mixer.getByLabel(text.mixer.muteOf(bass!.name))).toBeChecked();
  await expect(mixer.getByLabel(text.mixer.muteOf(guitar!.name))).not.toBeChecked();
  await expect(mixer.getByLabel(text.mixer.soloOf(guitar!.name))).toBeChecked();
  await expect(mixer.getByLabel(text.mixer.volumeOf(guitar!.name))).toHaveValue("0.5");
  await expect(mixer.getByLabel(text.mixer.volumeOf(bass!.name))).toHaveValue("1");
  await expect(mixer.getByLabel(text.mixer.speed)).toHaveValue("0.75");
  await expect(mixer.getByLabel(text.mixer.metronome)).toBeChecked();
  await expect(mixer.getByLabel(text.mixer.countIn)).toBeChecked();
  await expect(mixer.getByLabel(text.mixer.whilePlaying)).toHaveValue("b");

  // Another score: its own mix, as the score has it; the same metronome, count-in and behaviour.
  await openToPlay(page, other);
  const [otherGuitar, otherBass] = (await scoreOf(page)).parts;
  mixer = await openMixer(page);
  await expect(mixer.getByLabel(text.mixer.muteOf(otherBass!.name))).not.toBeChecked();
  await expect(mixer.getByLabel(text.mixer.soloOf(otherGuitar!.name))).not.toBeChecked();
  await expect(mixer.getByLabel(text.mixer.volumeOf(otherGuitar!.name))).toHaveValue("1");
  await expect(mixer.getByLabel(text.mixer.speed)).toHaveValue("1");
  await expect(mixer.getByLabel(text.mixer.metronome)).toBeChecked();
  await expect(mixer.getByLabel(text.mixer.whilePlaying)).toHaveValue("b");
  expect(errors).toEqual([]);
});

test("with bars 2-3 selected, playback at the end of bar 3 goes back to bar 2", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Control+Shift+ArrowRight");
  const mixer = await openMixer(page);
  await expect(mixer.locator("[data-loop]")).toContainText(text.mixer.loopBars(2, 3));
  await mixer.getByRole("button", { name: text.mixer.close }).click();

  await recordBarsShown(page);
  await page.getByRole("button", { name: text.player.play }).click();
  await expect.poll(() => barsShown(page), { timeout: 20_000 }).toEqual([3, 2, 3]);
  await page.getByRole("button", { name: text.player.pause }).click();
  await expect(page.locator('[data-player="paused"]')).toBeVisible();
  expect(await barsShown(page)).not.toContain(4);

  // No selection, no loop: playback goes on past bar 3.
  await page.keyboard.press("ArrowLeft");
  await recordBarsShown(page);
  await page.keyboard.press("Space");
  await untilShown(page, 4);
  expect(errors).toEqual([]);
});

test("with the metronome and the count-in on, the score plays, with no error", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  const mixer = await openMixer(page);
  await mixer.getByLabel(text.mixer.metronome).check();
  await mixer.getByLabel(text.mixer.countIn).check();
  await page.getByRole("button", { name: text.player.play }).click();
  await expect(page.locator('[data-player="playing"]')).toBeVisible();
  // A bar of count-in first, then the score.
  await expect(page.locator("[data-playing-bar]")).toHaveAttribute("data-bar", "2", { timeout: 15_000 });
  await expect(page.locator('[data-player="playing"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test("(b): a change while it plays is not heard yet, and the page says so; once paused, it is, and the notice goes", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  const mixer = await openMixer(page);
  await mixer.getByLabel(text.mixer.whilePlaying).selectOption({ label: text.mixer.modes.b });
  await mixer.getByRole("button", { name: text.mixer.close }).click();

  await recordBarsShown(page);
  await page.keyboard.press("Space");
  await untilShown(page, 2);
  await page.keyboard.press("5");
  await expect(page.locator("[data-behind]")).toHaveText(text.mixer.behind);
  await untilShown(page, 3);
  await expect(page.locator('[data-player="playing"]')).toBeVisible();
  await expect(page.locator("[data-behind]")).toBeVisible();
  expect(oneAfterAnother(await barsShown(page))).toBe(true);

  await page.keyboard.press("Space");
  await expect(page.locator('[data-player="paused"]')).toBeVisible();
  await expect(page.locator("[data-behind]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a tempo and a repeat set while it plays: playback goes on in the bar it was in, never back", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  await recordBarsShown(page);
  await page.keyboard.press("Space");
  await untilShown(page, 3);

  // The panel of the cursor's bar, the first: a tempo, then bar 1 played twice.
  await page.keyboard.press("F2");
  const panel = page.locator("[data-bar-panel]");
  await panel.locator('input[name="tempo"]').fill("150");
  await panel.locator('input[name="tempo"]').press("Enter");
  await expect.poll(async () => (await scoreOf(page)).bars[0]!.tempo).toBe(150);
  const repeat = panel.locator("[data-panel-repeat]");
  await repeat.locator('input[name="repeatTimes"]').fill("2");
  await repeat.locator('input[name="repeatTimes"]').press("Enter");
  await expect.poll(async () => (await scoreOf(page)).bars[0]!.repeatEnd).toBe(2);

  const after = (await barsShown(page)).at(-1)!;
  await untilShown(page, after + 2);
  const shown = await barsShown(page);
  expect(oneAfterAnother(shown), shown.join(", ")).toBe(true);
  await expect(page.locator('[data-player="playing"]')).toBeVisible();
  expect(errors).toEqual([]);
});
