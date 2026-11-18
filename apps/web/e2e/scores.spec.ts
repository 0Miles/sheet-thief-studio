// Creating a score and opening it as the server keeps it (#6; docs/spec/routes.md, section 1;
// docs/spec/security.md, section 8), with the parts, time signature and tempo chosen in its
// dialog (#11; docs/spec/commands.md, section 10). The page is read through `window.__studioTest` only.
import { expect, type Page, test } from "./test";
import type { ScoreJSON } from "@studio/score-model";

import { strings } from "../src/strings";
import { ADMIN, OUTSIDER } from "./environment";
import { logIn, logInFromStart, pageErrors } from "./pages";

/** Wait until the score is drawn, then read it. */
async function drawnScore(page: Page): Promise<ScoreJSON> {
  await expect(page.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  const score = await page.evaluate(() => window.__studioTest!.scoreJson());
  expect(score).not.toBeNull();
  return score!;
}

test("a score created on / opens by itself, as the server made it, the same after reloading; / lists it, and someone else gets the 404 page", async ({ page, browser }) => {
  const errors = pageErrors(page);
  // A title of its own, so that the list of an earlier run of this test does not hold it too.
  const title = `測試團譜 ${test.info().repeatEachIndex}-${Date.now()}`;
  await logInFromStart(page, ADMIN);

  await page.getByRole("button", { name: strings.home.newScore }).click();
  await page.getByLabel(strings.newScore.scoreTitle).fill(title);
  await page.getByRole("button", { name: strings.newScore.create }).click();
  await expect(page).toHaveURL(/\/scores\/[0-9a-f-]{36}$/);
  const address = page.url();

  const created = await drawnScore(page);
  expect(created.title).toBe(title);
  expect(created.parts).toHaveLength(1);
  expect(created.bars).toHaveLength(8);
  await expect(page.locator('[data-sync="synced"]')).toBeVisible();

  await page.reload();
  expect(await drawnScore(page)).toEqual(created);

  await page.goto("/");
  await expect(page.getByRole("link").filter({ has: page.getByText(title, { exact: true }) })).toBeVisible();
  expect(errors).toEqual([]);

  // Another account, not a member: the same address shows the 404 page once logged in.
  const stranger = await (await browser.newContext()).newPage();
  const strangerErrors = pageErrors(stranger, [
    { status: 401, path: "/api/me" },
    { status: 404, path: new URL(address).pathname.replace("/scores/", "/api/scores/") },
  ]);
  await stranger.goto(address);
  await logIn(stranger, OUTSIDER.username, OUTSIDER.password);
  await expect(stranger).toHaveURL(address);
  await expect(stranger.getByRole("heading", { name: strings.notFound.title })).toBeVisible();
  expect(await stranger.evaluate(() => window.__studioTest?.scoreJson() ?? null)).toBeNull();
  expect(strangerErrors).toEqual([]);
});

test("the parts, time signature and tempo chosen in the dialog are the score that opens", async ({ page }) => {
  const errors = pageErrors(page);
  await logInFromStart(page, ADMIN);

  await page.getByRole("button", { name: strings.home.newScore }).click();
  await page.getByLabel(strings.newScore.scoreTitle).fill(`選好的團譜 ${test.info().repeatEachIndex}-${Date.now()}`);
  const rows = page.locator("[data-part-row]");
  // Two six-string guitars in Drop tuning (the first line starts as one six-string guitar).
  await rows.nth(0).getByLabel(strings.newScore.count).fill("2");
  await rows.nth(0).getByLabel(strings.newScore.tuning).selectOption({ label: strings.newScore.tunings.drop });
  await page.getByRole("button", { name: strings.newScore.addPart }).click();
  await rows.nth(1).getByLabel(strings.newScore.preset).selectOption({ label: strings.presets.drums });
  await expect(rows.nth(1).getByLabel(strings.newScore.tuning)).toHaveCount(0);
  await page.getByRole("button", { name: strings.newScore.addPart }).click();
  await rows.nth(2).getByLabel(strings.newScore.preset).selectOption({ label: strings.presets.keys });
  // A five-string bass, its lowest string set by hand to A0.
  await page.getByRole("button", { name: strings.newScore.addPart }).click();
  await rows.nth(3).getByLabel(strings.newScore.preset).selectOption({ label: strings.presets.bass5 });
  await rows.nth(3).getByLabel(strings.newScore.tuning).selectOption({ label: strings.newScore.tunings.custom });
  await rows.nth(3).getByLabel(strings.newScore.string(5)).selectOption({ label: "A0" });
  await page.getByLabel(strings.newScore.beats).fill("3");
  await page.getByLabel(strings.newScore.beatUnit).selectOption({ label: strings.newScore.beatUnits[8] });
  await page.getByLabel(strings.newScore.tempo).fill("90");
  await page.getByRole("button", { name: strings.newScore.create }).click();
  await expect(page).toHaveURL(/\/scores\/[0-9a-f-]{36}$/);

  const score = await drawnScore(page);
  expect(score.parts.map(({ name, kind, tuning, staves, program }) => ({ name, kind, tuning, staves, program }))).toEqual([
    { name: "吉他 1", kind: "fretted", tuning: [64, 59, 55, 50, 45, 38], staves: [{ clef: "tab" }], program: 25 },
    { name: "吉他 2", kind: "fretted", tuning: [64, 59, 55, 50, 45, 38], staves: [{ clef: "tab" }], program: 25 },
    { name: "鼓 1", kind: "percussion", tuning: [], staves: [{ clef: "neutral" }], program: 0 },
    { name: "鍵盤 1", kind: "pitched", tuning: [], staves: [{ clef: "treble" }, { clef: "bass" }], program: 0 },
    { name: "貝斯 1", kind: "fretted", tuning: [43, 38, 33, 28, 21], staves: [{ clef: "tab" }], program: 33 },
  ]);
  expect(score.bars.map(({ timeSig }) => timeSig)).toEqual(Array(8).fill({ numerator: 3, denominator: 8 }));
  expect(score.bars[0]?.tempo).toBe(90);
  // All five are drawn.
  await expect(page.locator("[data-parts]")).toHaveAttribute("data-parts", score.parts.map(({ id }) => id).join(","));
  expect(errors).toEqual([]);
});

test("the dialog refuses more parts than a score can have", async ({ page }) => {
  const errors = pageErrors(page);
  await logInFromStart(page, ADMIN);
  await page.getByRole("button", { name: strings.home.newScore }).click();
  await page.getByLabel(strings.newScore.scoreTitle).fill("太多聲部");
  await page.getByLabel(strings.newScore.count).fill("16");
  await expect(page.getByRole("alert")).toHaveText(strings.newScore.tooManyParts);
  await expect(page.getByRole("button", { name: strings.newScore.create })).toBeDisabled();
  // A count far past the limit is refused as it is: the page does not make that many parts first.
  await page.getByLabel(strings.newScore.count).fill("10000000000");
  await expect(page.getByRole("alert")).toHaveText(strings.newScore.tooManyParts);
  await expect(page.getByRole("button", { name: strings.newScore.create })).toBeDisabled();
  // Fifteen guitars and drums are the most there may be.
  await page.getByLabel(strings.newScore.count).fill("15");
  await page.getByRole("button", { name: strings.newScore.addPart }).click();
  await page.locator("[data-part-row]").nth(1).getByLabel(strings.newScore.preset).selectOption({ label: strings.presets.drums });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: strings.newScore.create })).toBeEnabled();
  expect(errors).toEqual([]);
});
