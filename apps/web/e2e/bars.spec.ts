// Bars inserted and deleted, and the panel of the cursor's bar (#22; docs/spec/commands.md,
// section 6; docs/spec/keymap.md, sections 2, 5 and 7). Every key goes through the real keyboard;
// the page is read through `window.__studioTest` and the DOM only.
import { expect, test } from "./test";
import { addPart, createScore } from "@studio/score-model";
import * as Y from "yjs";

import { overlaps } from "../src/overlay";
import { ADMIN, EDITOR } from "./environment";
import { loggedIn, openScore, pageErrors, scoreOf, seedScore, synced } from "./pages";

test("a score two members left with no bars opens with its +bar button, which makes a bar to type in again", async ({ browser }) => {
  // What two members who each delete one of the last two bars at once leave behind (docs/spec/commands.md, section 9).
  const doc = new Y.Doc();
  createScore(doc, "沒有小節");
  addPart(doc, { name: "吉他 1", kind: "fretted" });
  const id = seedScore({ title: "沒有小節", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], state: Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64") });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await page.goto(`/scores/${id}`);
  // Drawn: empty, nothing laid out, and no error.
  await expect(page.locator("[data-ready]")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await synced(page);
  const append = page.locator("[data-append-bar]");
  await expect(append).toBeVisible();
  await expect(page.locator("[data-cursor]")).toHaveCount(0);
  expect((await scoreOf(page)).bars).toEqual([]);
  expect(await page.evaluate(() => window.__studioTest!.cursor())).toBeNull();

  await append.click();
  await expect.poll(async () => (await scoreOf(page)).bars.length).toBe(1);
  // Drawn, with the cursor on it.
  await expect(page.locator("[data-cursor]")).toBeVisible();
  const [bar] = (await scoreOf(page)).bars;
  expect(bar).toMatchObject({ timeSig: { numerator: 4, denominator: 4 } });
  expect(await page.evaluate(() => window.__studioTest!.cursor()?.barId)).toBe(bar!.id);
  await page.keyboard.press("5");
  expect((await scoreOf(page)).parts[0]!.content[bar!.id]!["0:0"]!.map((beat) => beat.notes)).toEqual([{ s1: { fret: 5 } }]);
  await synced(page);
  expect(errors).toEqual([]);
});

test("two members who each delete one of the last two bars at once leave no bars; the page stays, and Ctrl+Z brings the bar back", async ({ browser }) => {
  const id = seedScore({ title: "同時刪除", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], bars: 2 });
  const owner = await loggedIn(browser, ADMIN);
  const editor = await loggedIn(browser, EDITOR);
  const ownerErrors = pageErrors(owner);
  const editorErrors = pageErrors(editor);
  await openScore(owner, id);
  await openScore(editor, id);
  const [first, second] = (await scoreOf(owner)).bars.map((bar) => bar.id);

  // The owner deletes the first bar offline, while the editor deletes the second.
  await owner.context().setOffline(true);
  await expect(owner.locator('[data-sync="offline"]')).toBeVisible();
  await owner.keyboard.press("Control+Delete");
  expect((await scoreOf(owner)).bars.map((bar) => bar.id)).toEqual([second]);
  await editor.keyboard.press("Control+ArrowRight");
  await editor.keyboard.press("Control+Delete");
  expect((await scoreOf(editor)).bars.map((bar) => bar.id)).toEqual([first]);
  await synced(editor);
  await owner.context().setOffline(false);
  await synced(owner);
  await expect.poll(async () => (await scoreOf(editor)).bars).toEqual([]);
  expect((await scoreOf(owner)).bars).toEqual([]);
  // Nothing is drawn, no cursor is left, and +bar is there.
  for (const page of [owner, editor]) {
    await expect(page.locator("[data-cursor]")).toHaveCount(0);
    await expect(page.locator("[data-append-bar]")).toBeVisible();
  }

  // Undo needs no cursor: the owner's bar comes back, for both, and the cursor with it.
  await owner.keyboard.press("Control+z");
  expect((await scoreOf(owner)).bars.map((bar) => bar.id)).toEqual([first]);
  await expect(owner.locator("[data-cursor]")).toBeVisible();
  await synced(owner);
  await expect.poll(async () => (await scoreOf(editor)).bars.map((bar) => bar.id)).toEqual([first]);
  await expect(editor.locator("[data-cursor]")).toBeVisible();
  expect(ownerErrors).toEqual([]);
  expect(editorErrors).toEqual([]);
});

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

test("the panel sets a repeat over the selected bars, voltas, a key, a section and the pickup of the first bar; scoreJson follows, and Ctrl+Z undoes each", async ({ browser }) => {
  const id = seedScore({ title: "反覆與調號", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], bars: 4, parts: [{ name: "鼓 1", kind: "percussion" }] });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  const ids = (await scoreOf(page)).bars.map((bar) => bar.id);
  const marks = async () =>
    (await scoreOf(page)).bars.map(({ keySig, section, repeatStart, repeatEnd, voltas, anacrusis }) => ({ keySig, section, repeatStart, repeatEnd, voltas, anacrusis }));
  const none = { keySig: undefined, section: undefined, repeatStart: undefined, repeatEnd: undefined, voltas: undefined, anacrusis: undefined };
  expect(await marks()).toEqual([none, none, none, none]);

  // Bars 2 to 3 selected, the panel open on them.
  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("Control+Shift+ArrowRight");
  await page.locator("[data-toggle-panel]").click();
  const panel = page.locator("[data-bar-panel]");
  await expect(panel).toBeVisible();
  await expect(page.locator("[data-panel-bar]")).toContainText("第 2–3 小節");
  const repeat = panel.locator("[data-panel-repeat]");
  await repeat.locator('input[name="repeatTimes"]').fill("2");
  await repeat.locator('input[name="repeatTimes"]').press("Enter");
  await expect.poll(marks).toEqual([none, { ...none, repeatStart: true }, { ...none, repeatEnd: 2 }, none]);
  await expect(repeat.locator("[data-repeat-start]")).toBeVisible();
  await expect(repeat.locator("[data-repeat-end]")).toBeVisible();

  // The first ending on bar 3, where the selection left the cursor, the second on bar 4: one bar
  // each, the cursor's. Esc closes the panel, then ends the selection.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.keyboard.press("F2");
  await expect(page.locator("[data-panel-bar]")).toHaveAttribute("data-bar", "3");
  const voltas = panel.locator("[data-panel-voltas]");
  await voltas.locator('input[name="volta"][value="1"]').check();
  await voltas.getByRole("button", { name: "套用" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("F2");
  await expect(page.locator("[data-panel-bar]")).toHaveAttribute("data-bar", "4");
  await voltas.locator('input[name="volta"][value="2"]').check();
  // A third pass of a repeat played twice never sounds: the panel says so as it is ticked.
  const unplayed = voltas.locator("[data-voltas-unplayed]");
  await expect(unplayed).toHaveCount(0);
  await voltas.locator('input[name="volta"][value="3"]').check();
  await expect(unplayed).toContainText("第 3 遍");
  await voltas.locator('input[name="volta"][value="3"]').uncheck();
  await expect(unplayed).toHaveCount(0);
  await voltas.getByRole("button", { name: "套用" }).click();
  await expect.poll(async () => (await marks()).map((bar) => bar.voltas)).toEqual([undefined, undefined, [1], [2]]);
  // The pickup is the first bar's only.
  await expect(panel.locator("[data-panel-anacrusis]")).toHaveCount(0);

  // On the first bar: G major and a section from it, and the pickup.
  await page.keyboard.press("Escape");
  for (let bar = 4; bar > 1; bar--) await page.keyboard.press("Control+ArrowLeft");
  await page.keyboard.press("F2");
  await expect(page.locator("[data-panel-bar]")).toHaveAttribute("data-bar", "1");
  await panel.locator('select[name="fifths"]').selectOption("1");
  await panel.locator("[data-panel-key-sig]").getByRole("button", { name: "套用" }).click();
  await panel.locator('input[name="section"]').fill("前奏");
  await panel.locator('input[name="section"]').press("Enter");
  await panel.locator('input[name="anacrusis"]').check();
  await expect.poll(async () => (await marks())[0]).toEqual({ ...none, keySig: { fifths: 1, mode: "major" }, section: "前奏", anacrusis: true });
  // Nothing written on the bars after: the key holds from the first bar on.
  expect((await marks()).slice(1).map((bar) => bar.keySig)).toEqual([undefined, undefined, undefined]);
  await page.keyboard.press("Escape");
  await synced(page);
  expect((await scoreOf(page)).bars.map((bar) => bar.id)).toEqual(ids);

  // Each one undo step: the pickup, the section, the key, the two voltas, the repeat.
  for (let step = 0; step < 6; step++) await page.keyboard.press("Control+z");
  expect(await marks()).toEqual([none, none, none, none]);
  await synced(page);
  expect(errors).toEqual([]);
});
