// The buttons inside the score's scroller, +bar and the retry of a score that could not be drawn
// (#197; docs/spec/keymap.md, 1.1): with the focus on one, a key is the button's, not the score's.
// Space and Enter press it, and no key plays, opens the text entry or types a note. Every key goes
// through the real keyboard; the page is read through `window.__studioTest` and the DOM only.
import { expect, type Locator, type Page, test } from "./test";

import { strings } from "../src/strings";
import { ADMIN, EDITOR } from "./environment";
import { createPhrase, firstStringFrets, loggedIn, openPhrase, openToPlay, pageErrors, runName, scoreOf, seedScore, soundReady } from "./pages";

/** From now on, write down every state the player goes to; `playerStates` reads them back. */
async function recordPlayer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const states: string[] = [];
    (window as unknown as { playerStates: string[] }).playerStates = states;
    const player = document.querySelector("[data-player]")!;
    new MutationObserver(() => states.push(player.getAttribute("data-player")!)).observe(player, { attributes: true, attributeFilter: ["data-player"] });
  });
}

function playerStates(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { playerStates: string[] }).playerStates);
}

/** Press the key with the focus on the target. */
async function pressOn(target: Locator, key: string): Promise<void> {
  await target.focus();
  await expect(target).toBeFocused();
  await target.page().keyboard.press(key);
}

/** Press the key with the focus on +bar. */
function pressOnAppend(page: Page, key: string): Promise<void> {
  return pressOn(page.locator("[data-append-bar]"), key);
}

/** Space plays, the first the player does since `recordPlayer`, and Space again pauses. */
async function spacePlaysThenPauses(page: Page): Promise<void> {
  await page.keyboard.press("Space");
  await expect(page.locator('[data-player="playing"]')).toBeVisible();
  expect(await playerStates(page)).toEqual(["playing"]);
  await page.keyboard.press("Space");
  await expect(page.locator('[data-player="paused"]')).toBeVisible();
}

/** Cut every download of the music font short; how many were, so far. */
async function cutFontShort(page: Page): Promise<() => number> {
  let cut = 0;
  await page.route("**/font/Bravura.*", (route) => {
    cut += 1;
    return route.abort("internetdisconnected");
  });
  return () => cut;
}

/** Press the key with the focus on the retry of the score that could not be drawn: the font is asked for again. */
async function retryByKey(page: Page, key: string, cut: () => number): Promise<void> {
  const retry = page.locator("[data-draw-retry]");
  await expect(retry).toBeVisible();
  const before = cut();
  await pressOn(retry, key);
  await expect.poll(cut).toBeGreaterThan(before);
  await expect(page.locator("[data-scroller]")).toBeFocused();
}

test("in the edit view, Space and Enter on +bar add a bar each and nothing else; a digit there types nothing; the score has the keyboard again after", async ({ browser }) => {
  const id = seedScore({ title: "按鈕上的按鍵", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], bars: 2 });
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openToPlay(page, id);
  await recordPlayer(page);
  const scroller = page.locator("[data-scroller]");
  const entry = page.locator("[data-text-entry]");

  // A key of the score does nothing on the button, which keeps the focus.
  const before = await scoreOf(page);
  expect(before.bars).toHaveLength(2);
  await pressOnAppend(page, "5");
  expect(await scoreOf(page)).toEqual(before);
  await expect(page.locator("[data-append-bar]")).toBeFocused();

  await pressOnAppend(page, "Space");
  await expect.poll(async () => (await scoreOf(page)).bars.length).toBe(3);
  await expect(scroller).toBeFocused();
  // The next key is the score's: typed in the bar just made, where the cursor is.
  await page.keyboard.press("3");
  expect(firstStringFrets(await scoreOf(page), 0, 2)).toEqual([3]);

  await pressOnAppend(page, "Enter");
  await expect.poll(async () => (await scoreOf(page)).bars.length).toBe(4);
  await expect(entry).toHaveCount(0);
  await expect(scroller).toBeFocused();
  // On the score itself, on a beat, Enter opens the text entry, as before.
  await page.keyboard.press("4");
  await page.keyboard.press("Enter");
  await expect(entry).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(entry).toHaveCount(0);
  await expect(scroller).toBeFocused();

  // Nothing played so far: the first the player does is play at this Space, on the score itself.
  await spacePlaysThenPauses(page);
  expect(errors).toEqual([]);
});

test("in the phrase editor, Space and Enter on +bar add a bar each: nothing plays, and no text entry opens", async ({ browser }) => {
  const page = await loggedIn(browser, ADMIN);
  const errors = pageErrors(page);
  const id = await createPhrase(page, runName("按鈕上的按鍵"));
  await openPhrase(page, id);
  await soundReady(page);
  await recordPlayer(page);
  const scroller = page.locator("[data-scroller]");
  const entry = page.locator("[data-text-entry]");
  expect((await scoreOf(page)).bars).toHaveLength(1);

  await pressOnAppend(page, "Space");
  await expect.poll(async () => (await scoreOf(page)).bars.length).toBe(2);
  await expect(scroller).toBeFocused();
  await expect(entry).toHaveCount(0);
  // The next key is the phrase's: typed in the bar just made, where the cursor is.
  await page.keyboard.press("7");
  expect(firstStringFrets(await scoreOf(page), 0, 1)).toEqual([7]);

  // On that beat, where Enter on the phrase itself would open the text entry.
  await pressOnAppend(page, "Enter");
  await expect.poll(async () => (await scoreOf(page)).bars.length).toBe(3);
  await expect(scroller).toBeFocused();
  await expect(entry).toHaveCount(0);

  // Nothing played so far: the first the player does is play at this Space, on the phrase itself.
  await spacePlaysThenPauses(page);
  expect(errors).toEqual([]);
});

test("a score that could not be drawn: Enter and Space on its retry each ask for the music font again, in the edit view and in the phrase editor", async ({ browser }) => {
  const id = seedScore({ title: "重試的按鍵", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }] });
  const page = await loggedIn(browser, EDITOR);
  const phraseId = await createPhrase(page, runName("重試的按鍵"));
  const cut = await cutFontShort(page);
  const failed = page.locator("[data-draw-failed]");

  await page.goto(`/scores/${id}`);
  await expect(failed).toContainText(strings.score.drawing.failed);
  await expect(page.locator("main")).toHaveAttribute("data-view", "editable");
  await retryByKey(page, "Enter", cut);
  await retryByKey(page, "Space", cut);
  await expect(failed).toBeVisible();

  await page.goto(`/phrases/${phraseId}`);
  await expect(failed).toContainText(strings.score.drawing.failed);
  await retryByKey(page, "Space", cut);
  await retryByKey(page, "Enter", cut);
  await expect(failed).toBeVisible();
});
