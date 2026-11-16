// Bars inserted and deleted, and the panel of the cursor's bar (#22; docs/spec/commands.md,
// section 6; docs/spec/keymap.md, sections 2, 5 and 7). Every key goes through the real keyboard;
// the page is read through `window.__studioTest` and the DOM only.
import { expect, test } from "./test";

import { overlaps } from "../src/overlay";
import { ADMIN, EDITOR } from "./environment";
import { loggedIn, openScore, pageErrors, scoreOf, seedScore, synced } from "./pages";

const signatures = (bars: { timeSig: { numerator: number; denominator: number } }[]) => bars.map(({ timeSig }) => `${timeSig.numerator}/${timeSig.denominator}`);

test("the toolbar's button opens and closes the panel of the cursor's bar, as F2 does; the buttons say this platform's keys", async ({ browser }) => {
  const id = seedScore({ title: "小節屬性", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], bars: 12, parts: [{ name: "鼓 1", kind: "percussion" }] });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  const toggle = page.locator("[data-toggle-panel]");
  const panel = page.locator("[data-bar-panel]");
  const structure = page.locator("[data-structure]");
  await expect(toggle).toHaveAttribute("title", /（F2）$/);
  await expect(page.locator("[data-insert-bar]")).toHaveAttribute("title", /（Ctrl\+Insert）$/);
  await expect(page.locator("[data-delete-bars]")).toHaveAttribute("title", /（Ctrl\+Delete）$/);

  await expect(panel).toHaveCount(0);
  await expect(structure).toHaveCount(0);
  await toggle.click();
  await expect(panel).toBeVisible();
  await expect(page.locator("[data-panel-bar]")).toHaveAttribute("data-bar", "1");
  await expect(panel.locator('input[name="numerator"]')).toBeFocused();
  // The cursor's bar, dashed over both parts: one box for the bar, as tall as the two staves.
  await expect(structure).toHaveCount(1);
  const box = (await structure.boundingBox())!;
  const cursor = (await page.locator("[data-cursor]").boundingBox())!;
  expect(box.height).toBeGreaterThan(cursor.height * 4);
  // Clear of the area reserved for the engine's mark, at the top of a score of more than 10 bars.
  for (const area of await page.locator("[data-reserved]").all()) expect(overlaps(box, (await area.boundingBox())!)).toBe(false);
  await toggle.click();
  await expect(panel).toHaveCount(0);
  await expect(structure).toHaveCount(0);

  // F2 opens it from the score, Esc closes it from a field and gives the score the keyboard back.
  await page.keyboard.press("F2");
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.locator("[data-scroller]")).toBeFocused();
  await page.keyboard.press("F2");
  await page.keyboard.press("F2");
  await expect(panel).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("on a Mac, the buttons of the bars say the Mac's keys", async ({ browser }) => {
  const id = seedScore({ title: "Mac 的鍵", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }] });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  // The page tells the platform from navigator.platform once, when it loads (docs/spec/keymap.md, 1.3).
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  await openScore(page, id);
  await expect(page.locator("[data-insert-bar]")).toHaveAttribute("title", /（⌘↩）$/);
  await expect(page.locator("[data-delete-bars]")).toHaveAttribute("title", /（⌘⌫）$/);
  await expect(page.locator("[data-toggle-panel]")).toHaveAttribute("title", /（F2）$/);
  expect(errors).toEqual([]);
});

test("Ctrl+Insert gives every part one more bar, the panel turns 4/4 into 3/4, and Ctrl+Z undoes each", async ({ browser }) => {
  const id = seedScore({ title: "插入小節", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], bars: 3, parts: [{ name: "鼓 1", kind: "percussion" }] });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  const before = await scoreOf(page);
  expect(before.bars).toHaveLength(3);

  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("Control+Insert");
  const inserted = await scoreOf(page);
  expect(inserted.bars).toHaveLength(4);
  const added = inserted.bars[1]!.id;
  expect(inserted.bars.map((bar) => bar.id)).toEqual([before.bars[0]!.id, added, ...before.bars.slice(1).map((bar) => bar.id)]);
  for (const part of inserted.parts) expect(part.content[added]).toEqual({ "0:0": [] });
  await synced(page);

  // From the new bar on, up to the next change of time signature: here, every bar after it.
  await page.keyboard.press("F2");
  const panel = page.locator("[data-bar-panel]");
  await expect(page.locator("[data-panel-bar]")).toHaveAttribute("data-bar", "2");
  await panel.locator('input[name="numerator"]').fill("3");
  await panel.locator('input[name="numerator"]').press("Enter");
  await expect.poll(async () => signatures((await scoreOf(page)).bars)).toEqual(["4/4", "3/4", "3/4", "3/4"]);
  // The tempo of the bar, written on it only; the first bar keeps the tempo the score was made with.
  const first = before.bars[0]!.tempo ?? null;
  await panel.locator('input[name="tempo"]').fill("90");
  await panel.locator('input[name="tempo"]').press("Enter");
  await expect.poll(async () => (await scoreOf(page)).bars.map((bar) => bar.tempo ?? null)).toEqual([first, 90, null, null]);
  await page.keyboard.press("Escape");
  await synced(page);

  await page.keyboard.press("Control+z");
  expect((await scoreOf(page)).bars.map((bar) => bar.tempo ?? null)).toEqual([first, null, null, null]);
  await page.keyboard.press("Control+z");
  expect(signatures((await scoreOf(page)).bars)).toEqual(["4/4", "4/4", "4/4", "4/4"]);
  await page.keyboard.press("Control+z");
  expect((await scoreOf(page)).bars.map((bar) => bar.id)).toEqual(before.bars.map((bar) => bar.id));
  await synced(page);
  expect(errors).toEqual([]);
});

test("Ctrl+Delete deletes a bar range from every part with no question asked, and the +bar button at the end adds one", async ({ browser }) => {
  const id = seedScore({ title: "刪除小節", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], bars: 4 });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  const before = await scoreOf(page);
  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("Control+Shift+ArrowRight");
  // A bar range is dashed over every part too.
  await expect(page.locator("[data-structure]")).not.toHaveCount(0);
  await page.keyboard.press("Control+Delete");
  expect((await scoreOf(page)).bars.map((bar) => bar.id)).toEqual([before.bars[0]!.id, before.bars[3]!.id]);
  await expect(page.locator("[data-structure]")).toHaveCount(0);

  await page.locator("[data-append-bar]").click();
  const appended = await scoreOf(page);
  expect(appended.bars).toHaveLength(3);
  expect(await page.evaluate(() => window.__studioTest!.cursor()?.barId)).toBe(appended.bars[2]!.id);
  await expect(page.locator("[data-scroller]")).toBeFocused();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  expect((await scoreOf(page)).bars.map((bar) => bar.id)).toEqual(before.bars.map((bar) => bar.id));
  await synced(page);
  expect(errors).toEqual([]);
});
