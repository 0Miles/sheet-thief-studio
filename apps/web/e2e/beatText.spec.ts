// The text over a beat (#30; docs/spec/keymap.md, 6.1; docs/spec/views.md, section 9): Enter opens
// a box for it next to the cursor, Enter saves, Esc leaves, an empty text takes it away. Every key
// goes through the real keyboard; the page is read through `window.__studioTest` and the DOM only.
import { expect, type Page, test } from "./test";

import { overlaps } from "../src/overlay";
import { ADMIN, EDITOR } from "./environment";
import { beatsIn, cursorOf, drawn, loggedIn, openScore, pageErrors, scoreOf, seedScore, synced } from "./pages";

/** The text of the first beat of a bar of the first part, null for none. */
async function textOf(page: Page, bar = 0): Promise<string | null> {
  return beatsIn(await scoreOf(page), 0, bar)[0]?.text ?? null;
}

test("on a beat, Enter opens a box for its text: Am7 and Enter put it there, Esc leaves it, and emptied it is gone", async ({ browser }) => {
  const id = seedScore({ title: "拍點文字", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }] });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  const entry = page.locator("[data-text-entry]");
  await page.keyboard.press("5");
  await expect(entry).toHaveCount(0);

  await page.keyboard.press("Enter");
  await expect(entry).toBeFocused();
  await expect(entry).toHaveValue("");
  await page.keyboard.type("Am7");
  await page.keyboard.press("Enter");
  await expect(entry).toHaveCount(0);
  expect(await textOf(page)).toBe("Am7");
  // What was typed in the box was not the score's: the 7 wrote no fret.
  expect(beatsIn(await scoreOf(page), 0, 0)).toMatchObject([{ notes: { s1: { fret: 5 } } }]);
  await synced(page);

  // Esc leaves the box, and the text as it was; the score has the keyboard again.
  await page.keyboard.press("Enter");
  await expect(entry).toHaveValue("Am7");
  await page.keyboard.type("x");
  await page.keyboard.press("Escape");
  await expect(entry).toHaveCount(0);
  expect(await textOf(page)).toBe("Am7");
  await page.keyboard.press("8");
  expect(beatsIn(await scoreOf(page), 0, 0)).toMatchObject([{ notes: { s1: { fret: 8 } } }]);

  await page.reload();
  await drawn(page);
  expect(await textOf(page)).toBe("Am7");
  // The cursor starts on the first beat of the first bar.
  expect(await cursorOf(page)).toMatchObject({ at: "on" });
  await page.keyboard.press("Enter");
  await expect(entry).toHaveValue("Am7");
  // The box opens with its text selected: Backspace empties it.
  await page.keyboard.press("Backspace");
  await expect(entry).toHaveValue("");
  await page.keyboard.press("Enter");
  await expect(entry).toHaveCount(0);
  expect(await textOf(page)).toBeNull();
  expect(beatsIn(await scoreOf(page), 0, 0)[0]).not.toHaveProperty("text");
  await synced(page);
  expect(errors).toEqual([]);
});

// Below the cursor the box is clear of the mark's area by where it opens: that it moves out of a
// reserved area it would open into is tested on `entryRect` (tests/overlay.test.ts).
test("on a beat under the engine's mark, at the top of the page, the box of its text opens below its cursor and covers no reserved area", async ({ browser }) => {
  const id = seedScore({ title: "文字與標記", owner: ADMIN.username, bars: 12 });
  const page = await loggedIn(browser, ADMIN);
  const errors = pageErrors(page);
  await openScore(page, id);
  const reserved = page.locator("[data-reserved]");
  await expect(reserved).not.toHaveCount(0);
  const scroller = page.locator("[data-scroller]");
  const entry = page.locator("[data-text-entry]");
  const barIds = (await scoreOf(page)).bars.map((bar) => bar.id);

  // The last bar of the first system, under the mark: the last whose cursor is as high as the first bar's.
  const tops: number[] = [];
  for (let bar = 0; bar < barIds.length; bar++) {
    tops.push((await page.locator("[data-cursor]").boundingBox())!.y);
    if (bar < barIds.length - 1) await page.keyboard.press("ArrowRight");
  }
  const lastOfFirstSystem = tops.lastIndexOf(tops[0]!);
  expect(lastOfFirstSystem).toBeLessThan(barIds.length - 1);
  for (let bar = barIds.length - 1; bar > lastOfFirstSystem; bar--) await page.keyboard.press("ArrowLeft");
  expect(await cursorOf(page)).toMatchObject({ barId: barIds[lastOfFirstSystem] });
  await page.keyboard.press("3");
  await page.keyboard.press("Enter");
  await expect(entry).toBeVisible();
  await scroller.evaluate((element) => element.scrollTo(0, 0));
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);

  const box = (await entry.boundingBox())!;
  const areas = await Promise.all((await reserved.all()).map((area) => area.boundingBox()));
  expect(areas.length).toBeGreaterThan(0);
  for (const area of areas) expect(overlaps(box, area!)).toBe(false);
  // Next to the beat it is for: below its cursor, in the same bar.
  const cursor = (await page.locator("[data-cursor]").boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(cursor.y + cursor.height);
  expect(box.x).toBeCloseTo(cursor.x, 0);
  await page.keyboard.type("G");
  await page.keyboard.press("Enter");
  expect(beatsIn(await scoreOf(page), 0, lastOfFirstSystem)[0]).toMatchObject({ text: "G", notes: { s1: { fret: 3 } } });
  expect(errors).toEqual([]);
});
