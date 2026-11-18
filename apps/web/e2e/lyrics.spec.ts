// Lyrics mode (#50; docs/spec/keymap.md, 6.2; docs/spec/views.md, section 9): Shift+Enter on a
// voice opens a box below the beat; `-` and Space save a syllable and go on to the next sung beat,
// an empty box a melisma, and past the last sung beat lyrics mode ends. Every key goes through the
// real keyboard; the page is read through `window.__studioTest` and the DOM only.
import { expect, type Page, test } from "./test";

import { overlaps } from "../src/overlay";
import { ADMIN, EDITOR } from "./environment";
import { beatsIn, cursorOf, drawn, loggedIn, openScore, pageErrors, scoreOf, seedScore, synced } from "./pages";

/** The syllable of each beat of the first bar of the voice (the second part), null for none. */
async function lyricsOf(page: Page, bar = 0): Promise<(string | null)[]> {
  return beatsIn(await scoreOf(page), 1, bar).map((beat) => beat.lyric ?? null);
}

test("on a voice, Shift+Enter, Hel and -, lo and Space, then Space in the empty box: the three beats sing Hel-, lo and a melisma, and lyrics mode ends", async ({ browser }) => {
  const id = seedScore({ title: "歌詞模式", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], bars: 4, parts: [{ name: "人聲 1", kind: "pitched" }] });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  const voice = (await scoreOf(page)).parts[1]!.id;
  await page.keyboard.press("Control+ArrowDown");
  for (const key of ["c", "ArrowRight", "d", "ArrowRight", "e", "Home"]) await page.keyboard.press(key);
  const beatIds = beatsIn(await scoreOf(page), 1, 0).map((beat) => beat.id);
  expect(beatIds).toHaveLength(3);
  expect(await cursorOf(page)).toMatchObject({ partId: voice, beatId: beatIds[0], at: "on" });

  const entry = page.locator("[data-lyric-entry]");
  await page.keyboard.press("Shift+Enter");
  await expect(entry).toBeFocused();
  await expect(entry).toHaveValue("");
  await page.keyboard.type("Hel");
  await page.keyboard.press("-");
  // The box goes on to the next beat, the cursor with it.
  await expect(entry).toHaveValue("");
  await expect.poll(async () => (await cursorOf(page))?.beatId).toBe(beatIds[1]);
  await page.keyboard.type("lo");
  await page.keyboard.press("Space");
  await expect.poll(async () => (await cursorOf(page))?.beatId).toBe(beatIds[2]);
  // An empty box on the last sung beat: a melisma, and lyrics mode ends.
  await page.keyboard.press("Space");
  await expect(entry).toHaveCount(0);
  await expect(page.locator("[data-scroller]")).toBeFocused();
  const expected = ["Hel-", "lo", ""];
  expect(await lyricsOf(page)).toEqual(expected);
  // What was typed in the box was not the score's: no note was entered, and the notes are as they were.
  expect(beatsIn(await scoreOf(page), 1, 0).map((beat) => beat.notes)).toEqual([{ n72: { spell: "C" } }, { n74: { spell: "D" } }, { n76: { spell: "E" } }]);
  await drawn(page);
  await synced(page);

  // Esc leaves without saving; the box opens with the beat's syllable.
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+Enter");
  await expect(entry).toHaveValue("Hel-");
  await page.keyboard.type("x");
  await page.keyboard.press("Escape");
  await expect(entry).toHaveCount(0);
  expect(await lyricsOf(page)).toEqual(expected);

  await page.reload();
  await drawn(page);
  expect(await lyricsOf(page)).toEqual(expected);
  expect(errors).toEqual([]);
});

test("at the top of the page, the box of lyrics mode on the last bar of the first system opens below its beat and covers no reserved area", async ({ browser }) => {
  const id = seedScore({ title: "歌詞與標記", owner: ADMIN.username, bars: 12, parts: [{ name: "人聲 1", kind: "pitched" }] });
  const page = await loggedIn(browser, ADMIN);
  const errors = pageErrors(page);
  await openScore(page, id);
  const reserved = page.locator("[data-reserved]");
  await expect(reserved).not.toHaveCount(0);
  const scroller = page.locator("[data-scroller]");
  const entry = page.locator("[data-lyric-entry]");
  const barIds = (await scoreOf(page)).bars.map((bar) => bar.id);
  await page.keyboard.press("Control+ArrowDown");

  // The last bar of the first system, under the mark: the last whose cursor is as high as the first bar's.
  const tops: number[] = [];
  for (let bar = 0; bar < barIds.length; bar++) {
    tops.push((await page.locator("[data-cursor]").boundingBox())!.y);
    if (bar < barIds.length - 1) await page.keyboard.press("Control+ArrowRight");
  }
  const lastOfFirstSystem = tops.lastIndexOf(tops[0]!);
  expect(lastOfFirstSystem).toBeLessThan(barIds.length - 1);
  for (let bar = barIds.length - 1; bar > lastOfFirstSystem; bar--) await page.keyboard.press("Control+ArrowLeft");
  expect(await cursorOf(page)).toMatchObject({ barId: barIds[lastOfFirstSystem] });
  await page.keyboard.press("g");
  await page.keyboard.press("Shift+Enter");
  await expect(entry).toBeVisible();
  await scroller.evaluate((element) => element.scrollTo(0, 0));
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);

  const box = (await entry.boundingBox())!;
  const areas = await Promise.all((await reserved.all()).map((area) => area.boundingBox()));
  expect(areas.length).toBeGreaterThan(0);
  for (const area of areas) expect(overlaps(box, area!)).toBe(false);
  // Next to the beat it is for: below its cursor.
  const cursor = (await page.locator("[data-cursor]").boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(cursor.y + cursor.height);
  expect(box.x).toBeCloseTo(cursor.x, 0);
  await page.keyboard.type("la");
  await page.keyboard.press("Enter");
  await expect(entry).toHaveCount(0);
  expect(beatsIn(await scoreOf(page), 1, lastOfFirstSystem)[0]).toMatchObject({ lyric: "la", notes: { n67: { spell: "G" } } });
  expect(errors).toEqual([]);
});
