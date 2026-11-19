// Export (#71; docs/spec/import-export.md, section 3): any member downloads the score as a Guitar
// Pro 7 or a MIDI file, from the export menu of the edit views and of the Read view; a guest has
// no menu. The download is caught as the browser makes it, and the file read back by #69's import.
import { readFile } from "node:fs/promises";

import type { ScoreJSON } from "@studio/score-model";
import { importScore } from "@studio/score-render";

import { type BrowserContextOptions, type Download, expect, type Page, test } from "./test";

import { strings } from "../src/strings";
import { ADMIN, EDITOR, VIEWER } from "./environment";
import { drawn, loggedIn, pageErrors, runName, scoreOf, seedScore, typeBeats } from "./pages";

const text = strings.score.export;

/** A tablet's width, or a narrow desktop window: the wide Read view, which cannot be typed on. */
const TABLET: BrowserContextOptions = { viewport: { width: 900, height: 900 } };
/** A phone held upright: the narrow Read view, its options in a drawer. */
const PHONE: BrowserContextOptions = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true };

/** A score of a guitar, a bass and drums, the Editor and the Viewer members of it. */
function seed(title: string): string {
  return seedScore({
    title,
    owner: ADMIN.username,
    members: [
      { username: EDITOR.username, role: "editor" },
      { username: VIEWER.username, role: "viewer" },
    ],
    bars: 5,
    parts: [
      { name: "貝斯", kind: "fretted" },
      { name: "鼓", kind: "percussion" },
    ],
  });
}

/** Choose a format in the export menu; returns the download the browser made of it. */
async function exportAs(page: Page, format: "gp7" | "midi"): Promise<Download> {
  const menu = page.locator("[data-export-menu]");
  if ((await menu.evaluate((element) => element.tagName)) === "DETAILS") await menu.getByText(text.open, { exact: true }).click();
  const downloading = page.waitForEvent("download");
  await menu.getByRole("button", { name: text.formats[format] }).click();
  return downloading;
}

/**
 * The frets of the notes of the first part's first bar, beat by beat. Rests are left out: the
 * projection fills what is left of a bar with rests, which a file read back holds as beats.
 */
function frets(json: ScoreJSON): (number | undefined)[][] {
  const beats = json.parts[0]!.content[json.bars[0]!.id]?.["0:0"] ?? [];
  return beats.map((beat) => Object.values(beat.notes ?? {}).map((note) => note.fret)).filter((notes) => notes.length > 0);
}

async function bytesOf(download: Download): Promise<Uint8Array> {
  return new Uint8Array(await readFile((await download.path())!));
}

test("a member exports Guitar Pro 7 from the edit view: read back, it has the same parts and bars", async ({ browser }) => {
  const title = runName("匯出/GP7");
  const id = seed(title);
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await page.goto(`/scores/${id}`);
  await drawn(page);
  await expect(page.locator("main")).toHaveAttribute("data-view", "editable");
  await typeBeats(page, [3, 5, 7]);
  await expect.poll(async () => frets(await scoreOf(page))).toEqual([[3], [5], [7]]);
  const score = await scoreOf(page);

  const download = await exportAs(page, "gp7");
  // The title, with the slash no file name may hold made `_`.
  expect(download.suggestedFilename()).toBe(`${title.replace("/", "_")}.gp`);
  const read = importScore(await bytesOf(download), download.suggestedFilename());
  if (!read.ok) throw new Error(`the exported file reads back as ${read.failure}`);
  expect(read.score.title).toBe(title);
  expect(read.score.parts.map((part) => [part.name, part.kind])).toEqual(score.parts.map((part) => [part.name, part.kind]));
  expect(read.score.bars).toHaveLength(score.bars.length);
  expect(frets(read.score)).toEqual([[3], [5], [7]]);
  // The score has the keyboard again.
  await expect(page.locator("[data-scroller]")).toBeFocused();
  expect(errors).toEqual([]);
});

test("exported as MIDI, the score is a standard MIDI file", async ({ browser }) => {
  const title = runName("匯出 MIDI");
  const id = seed(title);
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await page.goto(`/scores/${id}`);
  await drawn(page);

  const download = await exportAs(page, "midi");
  expect(download.suggestedFilename()).toBe(`${title}.mid`);
  const bytes = await bytesOf(download);
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("MThd");
  expect(errors).toEqual([]);
});

test("a member's Read view has the export menu, wide and on a phone; a guest's has none", async ({ browser }) => {
  const id = seed(runName("匯出看譜"));

  // A Viewer on a tablet: the wide Read view.
  const viewer = await loggedIn(browser, VIEWER, TABLET);
  const viewerErrors = pageErrors(viewer);
  await viewer.goto(`/scores/${id}`);
  await drawn(viewer);
  await expect(viewer.locator("main")).toHaveAttribute("data-view", "read");
  await expect(viewer.locator("main")).toHaveAttribute("data-layout", "wide");
  const midi = await exportAs(viewer, "midi");
  expect(new TextDecoder().decode((await bytesOf(midi)).slice(0, 4))).toBe("MThd");
  expect(viewerErrors).toEqual([]);

  // The Editor on a phone: the menu is in the drawer of options.
  const phone = await loggedIn(browser, EDITOR, PHONE);
  const phoneErrors = pageErrors(phone);
  await phone.goto(`/scores/${id}`);
  await drawn(phone);
  await expect(phone.locator("main")).toHaveAttribute("data-layout", "narrow");
  await phone.getByRole("button", { name: strings.score.display.options }).click();
  await expect(phone.locator("[data-drawer] [data-export-menu]")).toBeVisible();
  const gp = await exportAs(phone, "gp7");
  expect([...(await bytesOf(gp)).slice(0, 2)]).toEqual([0x50, 0x4b]);
  expect(phoneErrors).toEqual([]);

  // A guest, by the read-only link: the same Read view, and no menu.
  const owner = await loggedIn(browser, ADMIN);
  const made = await owner.request.post(`/api/scores/${id}/link`, { headers: { origin: new URL(owner.url()).origin } });
  expect(made.status()).toBe(200);
  const { token } = (await made.json()) as { token: string };
  const guest = await (await browser.newContext()).newPage();
  const guestErrors = pageErrors(guest);
  await guest.goto(`/s/${token}`);
  await drawn(guest);
  await expect(guest.locator("main")).toHaveAttribute("data-view", "read");
  await expect(guest.locator("[data-toggle-mixer]")).toBeVisible();
  await expect(guest.locator("[data-export-menu]")).toHaveCount(0);
  expect(guestErrors).toEqual([]);
});
