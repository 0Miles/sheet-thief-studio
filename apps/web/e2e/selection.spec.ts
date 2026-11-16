// Selecting in the edit view and clearing what is selected (#21; docs/spec/commands.md, section 4
// and 5.6; docs/spec/views.md, section 9). Every key goes through the real keyboard; the page is
// read through `window.__studioTest` and the DOM only.
import { expect, type Page, test } from "./test";
import type { BeatJSON } from "@studio/score-model";

import { overlaps } from "../src/overlay";
import { ADMIN, EDITOR } from "./environment";
import { beatsIn, cursorOf, loggedIn, openScore, pageErrors, scoreOf, seedScore, synced } from "./pages";

const frets = (beats: BeatJSON[]) => beats.map((beat) => beat.notes.s1?.fret ?? null);

/** Type one quarter beat per fret from the cursor, in the append slot after each: the bar of 4/4 is then full. */
async function typeQuarters(page: Page, values: number[]): Promise<void> {
  for (const [index, fret] of values.entries()) {
    if (index > 0) await page.keyboard.press("ArrowRight");
    await page.keyboard.press(String(fret));
  }
}

test("three beats selected with Shift+→ become rests with Delete, and Ctrl+Z brings their notes back", async ({ browser }) => {
  const id = seedScore({ title: "選取測試", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }] });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  await typeQuarters(page, [1, 2, 3, 4]);
  for (let step = 0; step < 3; step++) await page.keyboard.press("ArrowLeft");
  const typed = beatsIn(await scoreOf(page), 0, 0);
  expect(frets(typed)).toEqual([1, 2, 3, 4]);
  expect(await cursorOf(page)).toMatchObject({ beatId: typed[0]!.id, at: "on" });

  const selection = page.locator("[data-selection]");
  await expect(selection).toHaveCount(0);
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(selection).toHaveCount(1);
  await page.keyboard.press("Delete");
  const cleared = beatsIn(await scoreOf(page), 0, 0);
  expect(cleared.map((beat) => [beat.id, beat.value])).toEqual(typed.map((beat) => [beat.id, beat.value]));
  expect(frets(cleared)).toEqual([null, null, null, 4]);
  expect(cleared.slice(0, 3).map((beat) => beat.notes)).toEqual([{}, {}, {}]);
  await synced(page);

  await page.keyboard.press("Control+z");
  expect(frets(beatsIn(await scoreOf(page), 0, 0))).toEqual([1, 2, 3, 4]);
  // Undo works on no selection: it ends it.
  await expect(selection).toHaveCount(0);
  await synced(page);
  expect(errors).toEqual([]);
});

test("at the top of a score of more than 10 bars, a selection never covers an area reserved for the engine's mark", async ({ browser }) => {
  const id = seedScore({ title: "選取與標記", owner: ADMIN.username, bars: 12 });
  const page = await loggedIn(browser, ADMIN);
  const errors = pageErrors(page);
  await openScore(page, id);
  const reserved = page.locator("[data-reserved]");
  await expect(reserved).not.toHaveCount(0);
  const scroller = page.locator("[data-scroller]");
  const selection = page.locator("[data-selection]");
  const barIds = (await scoreOf(page)).bars.map((bar) => bar.id);

  /** Every box of the selection is clear of every reserved area, with the page at the top. */
  async function clear(what: string): Promise<void> {
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
    const boxes = await Promise.all((await selection.all()).map((box) => box.boundingBox()));
    expect(boxes.length).toBeGreaterThan(0);
    const areas = await Promise.all((await reserved.all()).map((area) => area.boundingBox()));
    expect(areas.length).toBeGreaterThan(0);
    for (const box of boxes) for (const area of areas) expect(overlaps(box!, area!), what).toBe(false);
  }

  // Every bar, from the first: the first system's last bar, under the mark, among them.
  for (let bar = 1; bar < barIds.length; bar++) await page.keyboard.press("Control+Shift+ArrowRight");
  expect(await cursorOf(page)).toMatchObject({ barId: barIds.at(-1) });
  await expect(selection).not.toHaveCount(0);
  const systems = await selection.count();
  expect(systems).toBeGreaterThan(1);
  await clear("all the bars");

  // Back to the first bar; the bars of the first system share the top of their cursor.
  await page.keyboard.press("Escape");
  await expect(selection).toHaveCount(0);
  const tops: number[] = [];
  for (let bar = barIds.length - 1; bar >= 0; bar--) {
    tops.unshift((await page.locator("[data-cursor]").boundingBox())!.y);
    if (bar > 0) await page.keyboard.press("ArrowLeft");
  }
  expect(await cursorOf(page)).toMatchObject({ barId: barIds[0] });
  const lastOfFirstSystem = tops.lastIndexOf(tops[0]!);
  expect(lastOfFirstSystem).toBeLessThan(barIds.length - 1);
  for (let bar = 0; bar < lastOfFirstSystem; bar++) await page.keyboard.press("ArrowRight");

  // Beats in that bar, selected: a beat range under the mark.
  await typeQuarters(page, [1, 2, 3]);
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(selection).toHaveCount(1);
  expect(beatsIn(await scoreOf(page), 0, lastOfFirstSystem)).toHaveLength(3);
  await clear("a beat range under the mark");
  expect(errors).toEqual([]);
});
