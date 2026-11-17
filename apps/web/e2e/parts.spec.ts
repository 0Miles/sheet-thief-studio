// Parts managed from the panel of the parts, and the title changed in the title bar (#24;
// docs/spec/commands.md, section 7). The page is read through `window.__studioTest` and the DOM only.
import { expect, test } from "./test";
import { tuningFor } from "@studio/score-model";

import { strings } from "../src/strings";
import { ADMIN, EDITOR } from "./environment";
import { beatsIn, cursorOf, loggedIn, openScore, pageErrors, scoreOf, seedScore, synced } from "./pages";

const text = strings.score.parts;

test("a bass added, a part with content deleted (asked first, with its bars counted) and brought back, parts dragged into another order, a tuning and the title changed: the score follows each", async ({ browser }) => {
  const id = seedScore({ title: "聲部管理", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], bars: 4 });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  const [guitar] = (await scoreOf(page)).parts.map((part) => part.id);

  // Two bars of the guitar hold something.
  await page.keyboard.press("5");
  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("7");
  await synced(page);

  // A bass, from the presets, with a place for every bar.
  await page.locator("[data-toggle-parts]").click();
  const panel = page.locator("[data-part-panel]");
  await expect(panel).toBeVisible();
  const add = panel.locator("[data-add-part]");
  await add.getByLabel(text.preset).selectOption("bass4");
  await add.getByRole("button", { name: text.add }).click();
  await expect.poll(async () => (await scoreOf(page)).parts.map((part) => part.name)).toEqual(["吉他 1", "貝斯 1"]);
  const score = await scoreOf(page);
  const bass = score.parts[1]!;
  expect(bass).toMatchObject({ kind: "fretted", tuning: [43, 38, 33, 28], program: 33, capo: 0 });
  expect(Object.keys(bass.content).sort()).toEqual(score.bars.map((bar) => bar.id).sort());
  await expect(panel.locator("[data-part-row]")).toHaveCount(2);

  // Dragged above the guitar: the bass comes first.
  await panel.locator(`[data-part-row][data-part-id="${bass.id}"]`).dragTo(panel.locator(`[data-part-row][data-part-id="${guitar}"]`));
  await expect.poll(async () => (await scoreOf(page)).parts.map((part) => part.id)).toEqual([bass.id, guitar]);
  await expect(panel.locator("[data-part-row]").first()).toHaveAttribute("data-part-id", bass.id);

  // The guitar's tuning, drop D: its frets stay.
  await panel.locator(`[data-part-row][data-part-id="${guitar}"] [data-part-edit]`).click();
  const properties = panel.locator("[data-part-properties]");
  await expect(properties).toHaveAttribute("data-part-id", guitar!);
  await properties.locator("[data-part-tuning]").getByLabel(text.tuning).selectOption("drop");
  await properties.locator("[data-part-tuning]").getByRole("button", { name: text.apply }).click();
  await expect.poll(async () => (await scoreOf(page)).parts[1]!.tuning).toEqual(tuningFor("drop", 6));
  const guitarFrets = (await scoreOf(page)).parts[1]!;
  expect([0, 2].map((bar) => guitarFrets.content[score.bars[bar]!.id]!["0:0"]!.map((beat) => beat.notes.s1?.fret))).toEqual([[5], [7]]);

  // Deleted: asked first, told how many bars hold something.
  await panel.locator(`[data-part-row][data-part-id="${guitar}"]`).getByRole("button", { name: text.removeOf("吉他 1") }).click();
  const dialog = page.getByRole("dialog", { name: text.confirmDelete.title });
  await expect(dialog).toContainText(text.confirmDelete.message("吉他 1", 2));
  await dialog.getByRole("button", { name: text.confirmDelete.confirm }).click();
  await expect.poll(async () => (await scoreOf(page)).parts.map((part) => part.id)).toEqual([bass.id]);
  // The cursor was in it: it goes to the start of the score, in the part left.
  expect((await cursorOf(page))?.partId).toBe(bass.id);
  await expect(panel.locator(`[data-part-row][data-part-id="${bass.id}"] [data-part-delete]`)).toBeDisabled();
  // Undone: back with what it held.
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await scoreOf(page)).parts.map((part) => part.id)).toEqual([bass.id, guitar]);
  expect(beatsIn(await scoreOf(page), 1, 2).map((beat) => beat.notes.s1?.fret)).toEqual([7]);

  // The title and the artist, from the title bar.
  await page.locator("[data-edit-title]").click();
  const form = page.locator("[data-title-form]");
  await form.getByLabel(strings.score.heading.title).fill("新的標題");
  await form.getByLabel(strings.score.heading.artist).fill("某個樂團");
  await form.getByRole("button", { name: strings.score.heading.apply }).click();
  await expect.poll(async () => {
    const { title, artist } = await scoreOf(page);
    return { title, artist };
  }).toEqual({ title: "新的標題", artist: "某個樂團" });
  await expect(page.getByRole("heading", { name: "新的標題" })).toBeVisible();
  await expect(page.locator("[data-artist]")).toHaveText("某個樂團");
  await synced(page);
  // The list of scores reads the title the server mirrored.
  await page.goto("/");
  await expect(page.getByText("新的標題")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a Viewer has no panel of the parts nor a way to change the title", async ({ browser }) => {
  const id = seedScore({ title: "只能看", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "viewer" }] });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  await expect(page.locator("[data-toggle-parts]")).toHaveCount(0);
  await expect(page.locator("[data-edit-title]")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "只能看" })).toBeVisible();
  expect(errors).toEqual([]);
});
