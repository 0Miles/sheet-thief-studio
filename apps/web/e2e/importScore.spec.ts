// Importing a file as a new score on / (#70; docs/spec/import-export.md, section 2): the file is
// read in the browser, its import report shown, and once confirmed the server makes the score and
// it opens. The samples are those of score-render's round-trip test.
import { fileURLToPath } from "node:url";

import { GP7_SAMPLE } from "../../../packages/score-render/tests/fixtures/samples";
import { strings } from "../src/strings";
import { accountsFor, drawn, logInFromStart, pageErrors, scoreOf, storedAs } from "./pages";
import { expect, type Page, test } from "./test";

const text = strings.importScore;
const fixture = (name: string) => fileURLToPath(new URL(`../../../packages/score-render/tests/fixtures/${name}`, import.meta.url));

/** Choose a file to import, as the button on / does. */
async function choose(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }): Promise<void> {
  await page.getByLabel(strings.home.importFile).setInputFiles(file);
}

test("the GP7 sample imported on / shows its report, and once confirmed opens as a new score with its parts and bars", async ({ page }) => {
  const errors = pageErrors(page);
  const { account } = accountsFor(test.info());
  await logInFromStart(page, account("import", "匯入者"));
  await expect(page.getByRole("button", { name: strings.home.importScore })).toBeVisible();

  await choose(page, fixture("round-trip.gp"));
  const dialog = page.getByRole("dialog", { name: text.title });
  await expect(dialog.getByText(text.summary(GP7_SAMPLE.parts.length, GP7_SAMPLE.bars.length))).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByRole("region", { name: text.reportTitle })).toContainText(text.nothingLost);
  // Nothing is made before it is confirmed.
  expect((await (await page.request.get("/api/scores")).json()).scores).toEqual([]);

  await dialog.getByRole("button", { name: text.create }).click();
  await expect(page).toHaveURL(/\/scores\/[0-9a-f-]{36}$/);
  await drawn(page);
  const score = await scoreOf(page);
  expect(score.title).toBe(GP7_SAMPLE.title);
  expect(score.parts.map(({ name, kind }) => ({ name, kind }))).toEqual(GP7_SAMPLE.parts.map(({ name, kind }) => ({ name, kind })));
  expect(score.bars).toHaveLength(GP7_SAMPLE.bars.length);

  // Its row has the file's title and artist, and / lists it as mine.
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  await storedAs(page, id, { title: GP7_SAMPLE.title, artist: GP7_SAMPLE.artist ?? null });
  await page.goto("/");
  await expect(page.getByRole("link").filter({ has: page.getByText(GP7_SAMPLE.title, { exact: true }) })).toBeVisible();
  expect(errors).toEqual([]);
});

test("what a file cannot keep is listed with its bars before anything is made; a file that is no score says so, and nothing is made", async ({ page }) => {
  const errors = pageErrors(page);
  const { account } = accountsFor(test.info());
  await logInFromStart(page, account("report", "看報告的人"));

  // The MusicXML sample has a segno, a coda and a D.S.: jumps the score has not.
  await choose(page, fixture("round-trip.musicxml"));
  const dialog = page.getByRole("dialog", { name: text.title });
  const jump = dialog.locator('[data-loss="jump"]');
  await expect(jump).toContainText(text.losses.jump, { timeout: 30_000 });
  await expect(jump).toContainText(text.bars([3, 4]));
  await dialog.getByRole("button", { name: text.cancel }).click();
  await expect(dialog).toBeHidden();

  await choose(page, { name: "notes.gp", mimeType: "application/octet-stream", buffer: Buffer.from("not a score at all") });
  await expect(dialog.getByRole("alert")).toHaveText(text.failures.unreadable, { timeout: 30_000 });
  await expect(dialog.getByRole("button", { name: text.create })).toHaveCount(0);
  await dialog.getByRole("button", { name: text.close }).first().click();
  await expect(dialog).toBeHidden();

  expect((await (await page.request.get("/api/scores")).json()).scores).toEqual([]);
  await expect(page).toHaveURL("/");
  expect(errors).toEqual([]);
});
