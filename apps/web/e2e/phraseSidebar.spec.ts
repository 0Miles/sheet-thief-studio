// The phrase sidebar of the editable view (#57; docs/spec/phrases.md, section 6; docs/spec/keymap.md,
// sections 5 and 7): opened by the toolbar's button or F4, a phrase dragged onto a bar or dropped on
// the cursor's bar with Enter, never on a part of another kind; its preview wraps and scrolls, clear
// of the reserved areas; a Viewer's read-only edit view has none.
import { expect, type Page, test } from "./test";
import { type BarsFragment, type ScoreJSON } from "@studio/score-model";

import { overlaps } from "../src/overlay";
import { strings } from "../src/strings";
import { ADMIN, EDITOR, VIEWER } from "./environment";
import { createPhrase, loggedIn, openScore, pageErrors, runName, scoreOf, seedScore, synced } from "./pages";

const text = strings.score.phraseSidebar;
const GUITAR = [64, 59, 55, 50, 45, 40];

/** A guitar phrase: each bar four quarters on the first string, of the frets given. */
function guitarPhrase(...bars: number[][]): BarsFragment {
  return {
    kind: "fretted",
    tuning: [...GUITAR],
    bars: bars.map((frets) => ({ timeSig: { numerator: 4, denominator: 4 }, voices: { "0:0": frets.map((fret) => ({ value: 4 as const, dots: 0 as const, notes: { s1: { fret } } })) } })),
  };
}

/** The frets on the first string of a bar of a part, beat by beat, both by index. */
function fretsIn(score: ScoreJSON, part: number, bar: number): (number | undefined)[] {
  const barId = score.bars[bar]!.id;
  return (score.parts[part]!.content[barId]?.["0:0"] ?? []).map((beat) => beat.notes.s1?.fret);
}

/** The middle of the cursor as drawn now: a point of its bar, in its part. */
async function cursorPoint(page: Page): Promise<{ x: number; y: number }> {
  const box = (await page.locator("[data-cursor]").boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Open the sidebar with the toolbar's button and find a phrase by its name. */
async function findPhrase(page: Page, name: string) {
  await page.locator("[data-toggle-phrases]").click();
  await page.locator("[data-phrase-search]").fill(name);
  const item = page.locator("[data-phrase]", { hasText: name });
  await expect(item).toBeVisible();
  return item;
}

/** Drag the phrase to a point of the score, holding it there while `meanwhile` looks; then drop it. */
async function dragTo(page: Page, item: ReturnType<Page["locator"]>, to: { x: number; y: number }, meanwhile?: () => Promise<void>): Promise<void> {
  await item.hover();
  await page.mouse.down();
  await page.mouse.move(to.x - 20, to.y, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 5 });
  await meanwhile?.();
  await page.mouse.up();
}

test("the toolbar's button opens and closes the sidebar, the keyboard going to its search box; F4 does the same", async ({ browser }) => {
  const id = seedScore({ title: "樂句側欄", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }] });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  const toggle = page.locator("[data-toggle-phrases]");
  const sidebar = page.locator("[data-phrase-sidebar]");
  await expect(toggle).toHaveAttribute("title", /（F4）$/);
  await expect(sidebar).toBeHidden();

  await toggle.click();
  await expect(sidebar).toBeVisible();
  await expect(page.locator("[data-phrase-search]")).toBeFocused();
  await toggle.click();
  await expect(sidebar).toBeHidden();
  await expect(page.locator("[data-scroller]")).toBeFocused();

  await page.keyboard.press("F4");
  await expect(sidebar).toBeVisible();
  await expect(page.locator("[data-phrase-search]")).toBeFocused();
  await page.keyboard.press("F4");
  await expect(sidebar).toBeHidden();
  await expect(page.locator("[data-scroller]")).toBeFocused();
  expect(errors).toEqual([]);
});

test("a two-bar phrase dragged onto bar 3 becomes bars 3 and 4 of the part; Ctrl+Z takes it back", async ({ browser }) => {
  const id = seedScore({ title: "拖曳樂句", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }] });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  const name = runName("兩小節");
  await createPhrase(page, name, guitarPhrase([1, 2, 3, 4], [5, 6, 7, 8]));
  await openScore(page, id);
  const before = await scoreOf(page);
  const item = await findPhrase(page, name);
  // Where bar 3 is drawn, the score narrower beside the sidebar: the cursor taken there, and back.
  await page.locator("[data-scroller]").focus();
  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("Control+ArrowRight");
  const bar3 = await cursorPoint(page);
  await page.keyboard.press("Control+ArrowLeft");
  await page.keyboard.press("Control+ArrowLeft");

  await dragTo(page, item, bar3, async () => {
    await expect(page.locator('[data-drop="ok"]').first()).toBeVisible();
  });
  await expect.poll(async () => fretsIn(await scoreOf(page), 0, 2)).toEqual([1, 2, 3, 4]);
  expect(fretsIn(await scoreOf(page), 0, 3)).toEqual([5, 6, 7, 8]);
  expect(fretsIn(await scoreOf(page), 0, 1)).toEqual([]);
  await expect(page.locator("[data-drop-target]")).toHaveCount(0);
  await synced(page);

  await expect(page.locator("[data-scroller]")).toBeFocused();
  await page.keyboard.press("Control+z");
  await expect.poll(async () => (await scoreOf(page)).parts[0]!.content).toEqual(before.parts[0]!.content);
  expect(errors).toEqual([]);
});

test("Enter on a phrase, or with its preview open, drops it on the cursor's bar; a drop past the end appends bars and says so", async ({ browser }) => {
  const id = seedScore({ title: "按鍵放置", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], bars: 4 });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  const name = runName("按鍵");
  await createPhrase(page, name, guitarPhrase([3, 3, 3, 3], [7, 7, 7, 7]));
  await openScore(page, id);
  await page.keyboard.press("Control+ArrowRight");

  const item = await findPhrase(page, name);
  await item.focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => fretsIn(await scoreOf(page), 0, 1)).toEqual([3, 3, 3, 3]);
  expect(fretsIn(await scoreOf(page), 0, 2)).toEqual([7, 7, 7, 7]);
  // Enter dropped it: it did not open the preview, as a click does.
  await expect(page.locator("[data-phrase-preview]")).toBeHidden();

  // The cursor on the last bar: the second bar of the phrase is appended to the score.
  await page.locator("[data-scroller]").focus();
  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("Control+ArrowRight");
  await item.click();
  await expect(page.locator("[data-phrase-preview]")).toBeVisible();
  await page.locator("[data-phrase-search]").focus();
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await scoreOf(page)).bars.length).toBe(5);
  expect(fretsIn(await scoreOf(page), 0, 3)).toEqual([3, 3, 3, 3]);
  expect(fretsIn(await scoreOf(page), 0, 4)).toEqual([7, 7, 7, 7]);
  await expect(page.getByRole("status").filter({ hasText: text.hints.barsAppended })).toBeVisible();
  expect(errors).toEqual([]);
});

test("a guitar phrase dragged over the drums shows it cannot go there, and dropped there does nothing", async ({ browser }) => {
  const id = seedScore({ title: "不能放", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], parts: [{ name: "鼓 1", kind: "percussion" }] });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  const name = runName("鼓上");
  await createPhrase(page, name, guitarPhrase([1, 2, 3, 4]));
  await openScore(page, id);
  const before = await scoreOf(page);
  const item = await findPhrase(page, name);
  // Where the drums' first bar is drawn, beside the sidebar: the cursor taken there, and back to the guitar.
  await page.locator("[data-scroller]").focus();
  await page.keyboard.press("Control+ArrowDown");
  const drums = await cursorPoint(page);
  await page.keyboard.press("Control+ArrowUp");

  await dragTo(page, item, drums, async () => {
    await expect(page.locator('[data-drop="refused"]').first()).toBeVisible();
    await expect(page.locator('[data-drop="ok"]')).toHaveCount(0);
    await expect(page.locator("[data-drop-label]")).toHaveText(text.cannotDrop);
  });
  await expect(page.locator("[data-drop-target]")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await scoreOf(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test("the preview of a 12-bar phrase wraps and scrolls, never cut to a height, and its overlay stays clear of the reserved areas", async ({ browser }) => {
  const id = seedScore({ title: "預覽", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }] });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  const name = runName("十二小節");
  await createPhrase(page, name, guitarPhrase(...Array.from({ length: 12 }, (_, bar) => [bar, bar, bar, bar])));
  await openScore(page, id);

  const item = await findPhrase(page, name);
  await item.click();
  const preview = page.locator("[data-phrase-preview]");
  await expect(preview).toHaveAttribute("data-preview-ready", "true", { timeout: 30_000 });
  const scroller = preview.locator("[data-preview-scroller]");
  await expect(scroller).toHaveJSProperty("scrollTop", 0);

  // More than 10 bars: the engine's mark is drawn, its area reserved.
  const reserved = preview.locator("[data-reserved]");
  await expect(reserved).not.toHaveCount(0);
  const marks = await preview.locator("[data-preview-bars]").all();
  expect(marks.length).toBeGreaterThan(0);
  const areas = await Promise.all((await reserved.all()).map((area) => area.boundingBox()));
  for (const mark of marks) {
    const box = (await mark.boundingBox())!;
    for (const area of areas) expect(overlaps(box, area!)).toBe(false);
  }

  // Wrapped to its width, down more than one system, and scrolled rather than cut.
  const sizes = await scroller.evaluate((element) => {
    const host = element.querySelector<HTMLElement>("[data-preview-host]")!;
    return { overflow: getComputedStyle(element).overflowY, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, hostHeight: host.getBoundingClientRect().height, hostContent: host.scrollHeight };
  });
  expect(["auto", "scroll"]).toContain(sizes.overflow);
  expect(sizes.hostContent).toBeLessThanOrEqual(Math.ceil(sizes.hostHeight) + 1);
  expect(sizes.scrollHeight).toBeGreaterThanOrEqual(Math.floor(sizes.hostHeight));
  expect(marks.length).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});

test("a Viewer's read-only edit view has no phrase sidebar, by button or by F4", async ({ browser }) => {
  const id = seedScore({ title: "檢視者沒有側欄", owner: ADMIN.username, members: [{ username: VIEWER.username, role: "viewer" }] });
  const page = await loggedIn(browser, VIEWER);
  const errors = pageErrors(page);
  await openScore(page, id);
  await expect(page.locator("main")).toHaveAttribute("data-view", "readOnlyEdit");
  await expect(page.locator("[data-toggle-phrases]")).toHaveCount(0);
  await page.keyboard.press("F4");
  await expect(page.locator("[data-phrase-sidebar]")).toHaveCount(0);
  expect(errors).toEqual([]);
});
