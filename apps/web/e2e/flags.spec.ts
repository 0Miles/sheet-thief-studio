// Flags on the page (#36; docs/spec/flags.md, section 4): their number in the toolbar, F8 and the
// toolbar's button taking the cursor to the next one, a box on a bar and a mark on a note in
// every view, clear of the reserved areas. Every key goes through the real keyboard; the page is
// read through `window.__studioTest` and the DOM only.
import { type BrowserContextOptions, expect, type Page, test } from "@playwright/test";

import { overlaps } from "../src/overlay";
import { strings } from "../src/strings";
import { ADMIN, EDITOR } from "./environment";
import { cursorOf, drawn, loggedIn, openScore, pageErrors, scoreOf, seedScore, synced } from "./pages";

const text = strings.score.flags;

/** A tablet's width, or a narrow desktop window: the wide Read view, which cannot be typed on. */
const TABLET: BrowserContextOptions = { viewport: { width: 900, height: 900 } };

const flagsOf = (page: Page) => page.evaluate(() => window.__studioTest!.flags());

test("a bar left underfull is counted in the toolbar, and F8 and the toolbar's button take the cursor there", async ({ browser }) => {
  const id = seedScore({ title: "標記測試", owner: ADMIN.username });
  const page = await loggedIn(browser, ADMIN);
  const errors = pageErrors(page);
  await openScore(page, id);
  const count = page.locator("[data-flag-count]");
  await expect(count).toHaveAttribute("data-count", "0");
  const { bars, parts } = await scoreOf(page);

  // One quarter in the second bar of 4/4.
  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("5");
  await expect(count).toHaveAttribute("data-count", "1");
  await expect(count).toHaveText(text.count(1));
  expect(await flagsOf(page)).toEqual([{ kind: "underfull", partId: parts[0]!.id, barId: bars[1]!.id, voice: "0:0" }]);
  await expect(page.locator('[data-flag][data-kind="underfull"]')).toHaveCount(1);

  await page.keyboard.press("Control+ArrowLeft");
  expect(await cursorOf(page)).toMatchObject({ barId: bars[0]!.id });
  await page.keyboard.press("F8");
  expect(await cursorOf(page)).toMatchObject({ barId: bars[1]!.id, at: "on" });
  await expect(page.locator("[data-flag-stopped]")).toHaveText(text.kinds.underfull);
  // The only flag: F8 stays on it.
  await page.keyboard.press("F8");
  expect(await cursorOf(page)).toMatchObject({ barId: bars[1]!.id });

  await page.keyboard.press("Control+ArrowLeft");
  await expect(page.locator("[data-flag-stopped]")).toHaveCount(0);
  await page.getByRole("button", { name: text.next }).click();
  expect(await cursorOf(page)).toMatchObject({ barId: bars[1]!.id, at: "on" });
  // The score has the keyboard again.
  await page.keyboard.press("6");
  expect((await scoreOf(page)).parts[0]!.content[bars[1]!.id]!["0:0"]!.map((beat) => beat.notes.s1?.fret)).toEqual([6]);
  await synced(page);
  expect(errors).toEqual([]);
});

test("the Read view draws the flags too", async ({ browser }) => {
  const id = seedScore({ title: "看譜標記", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }] });
  const editor = await loggedIn(browser, EDITOR);
  await openScore(editor, id);
  await editor.keyboard.press("5");
  await editor.keyboard.press("Shift+L");
  await synced(editor);

  const page = await loggedIn(browser, ADMIN, TABLET);
  const errors = pageErrors(page);
  await page.goto(`/scores/${id}`);
  await drawn(page);
  await expect(page.locator("main")).toHaveAttribute("data-view", "read");
  await expect(page.locator("[data-flag-count]")).toHaveAttribute("data-count", "2");
  expect((await flagsOf(page)).map((flag) => flag.kind)).toEqual(["underfull", "danglingTie"]);
  await expect(page.locator('[data-flag][data-kind="underfull"]')).toHaveCount(1);
  await expect(page.locator('[data-flag][data-kind="danglingTie"]')).toHaveCount(1);
  // No cursor to take anywhere.
  await expect(page.getByRole("button", { name: text.next })).toHaveCount(0);
  expect(errors).toEqual([]);
});

/** Every flag drawn is clear of every reserved area, with the page scrolled to its top. */
async function clearOfReserved(page: Page, what: string): Promise<void> {
  const scroller = page.locator("[data-scroller]");
  await scroller.hover();
  await page.mouse.wheel(0, -100_000);
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
  const areas = await Promise.all((await page.locator("[data-reserved]").all()).map((area) => area.boundingBox()));
  expect(areas.length).toBeGreaterThan(0);
  for (const kind of ["underfull", "danglingTie"]) {
    const marks = await Promise.all((await page.locator(`[data-flag][data-kind="${kind}"]`).all()).map((mark) => mark.boundingBox()));
    expect(marks.length, `${what}: ${kind}`).toBeGreaterThan(0);
    for (const mark of marks) for (const area of areas) expect(overlaps(mark!, area!), `${what}: ${kind} at ${JSON.stringify(mark)}`).toBe(false);
  }
}

test("scrolled to the top, no flag box and no flag mark covers a reserved area, in the edit view and the Read view", async ({ browser }) => {
  const id = seedScore({ title: "標記與保留區域", owner: ADMIN.username, bars: 12 });
  const page = await loggedIn(browser, ADMIN);
  const errors = pageErrors(page);
  await openScore(page, id);
  await expect(page.locator("[data-reserved]")).not.toHaveCount(0);
  const { bars } = await scoreOf(page);

  // In every bar, the bar under the mark among them: a note on the top string, the nearest to the
  // mark, tied with nothing before it there, then a note on the second string, so that the next
  // bar's tie has no note before it either. Two quarters: each bar is underfull too.
  for (let bar = 0; bar < bars.length; bar++) {
    await page.keyboard.press("5");
    await page.keyboard.press("Shift+L");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("7");
    await page.keyboard.press("ArrowUp");
    if (bar < bars.length - 1) await page.keyboard.press("Control+ArrowRight");
  }
  const flags = await flagsOf(page);
  expect(flags.filter((flag) => flag.kind === "underfull")).toHaveLength(bars.length);
  expect(flags.filter((flag) => flag.kind === "danglingTie").map((flag) => "noteKey" in flag && flag.noteKey)).toEqual(bars.map(() => "s1"));
  await expect(page.locator("[data-flag-count]")).toHaveAttribute("data-count", String(2 * bars.length));
  await synced(page);
  await clearOfReserved(page, "the edit view");

  const reader = await loggedIn(browser, ADMIN, TABLET);
  const readerErrors = pageErrors(reader);
  await reader.goto(`/scores/${id}`);
  await drawn(reader);
  await expect(reader.locator("main")).toHaveAttribute("data-view", "read");
  await expect(reader.locator("[data-reserved]")).not.toHaveCount(0);
  await clearOfReserved(reader, "the Read view");
  expect(errors).toEqual([]);
  expect(readerErrors).toEqual([]);
});
