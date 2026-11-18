// Typing on drums in the edit view (#44; docs/spec/keymap.md, 4.2): a piece's key turns it on and
// off, Delete takes every piece off the cursor's line. Every key goes through the real keyboard;
// the page is read through `window.__studioTest` and the DOM only.
import { DRUM_PIECES } from "@studio/score-model";

import { expect, test } from "./test";
import { ADMIN, EDITOR } from "./environment";
import { beatsIn, cursorOf, drawn, loggedIn, openScore, pageErrors, scoreOf, seedScore, synced } from "./pages";

/** A score whose second part is drums; the cursor starts on the guitar, Ctrl+↓ takes it to the drums. */
function seed(): string {
  return seedScore({ title: "鼓的打譜", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], bars: 4, parts: [{ name: "鼓 1", kind: "percussion" }] });
}

test("on drums, K, H, →, S, H make two beats, kick and hi-hat, then snare and hi-hat; after reloading the score holds them", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  const start = await scoreOf(page);
  await page.keyboard.press("Control+ArrowDown");
  expect(await cursorOf(page)).toMatchObject({ partId: start.parts[1]!.id, barId: start.bars[0]!.id, beatId: null, at: "after" });

  for (const key of ["k", "h", "ArrowRight", "s", "h"]) await page.keyboard.press(key);
  const drums = async () => beatsIn(await scoreOf(page), 1, 0).map((beat) => beat.notes);
  expect(await drums()).toEqual([
    { p36: {}, p42: {} },
    { p38: {}, p42: {} },
  ]);
  // On the second beat, on the hi-hat's line, where the cursor is drawn.
  const second = beatsIn(await scoreOf(page), 1, 0)[1]!;
  expect(await cursorOf(page)).toMatchObject({ beatId: second.id, at: "on", line: DRUM_PIECES.hiHatClosed.line });
  await drawn(page);
  await expect(page.locator("[data-cursor]")).toBeVisible();
  await synced(page);

  await page.reload();
  await drawn(page);
  expect(await drums()).toEqual([
    { p36: {}, p42: {} },
    { p38: {}, p42: {} },
  ]);
  expect(errors).toEqual([]);
});

test("on drums, Delete with the cursor on the hi-hat's line takes off every piece drawn there and keeps the snare", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  await page.keyboard.press("Control+ArrowDown");

  // Snare, closed and open hi-hat: the two hi-hats share a line.
  for (const key of ["s", "h", "o"]) await page.keyboard.press(key);
  const drums = async () => beatsIn(await scoreOf(page), 1, 0).map((beat) => beat.notes);
  expect(await drums()).toEqual([{ p38: {}, p42: {}, p46: {} }]);
  expect(await cursorOf(page)).toMatchObject({ line: DRUM_PIECES.hiHatOpen.line });

  await page.keyboard.press("Delete");
  expect(await drums()).toEqual([{ p38: {} }]);
  await synced(page);
  await page.reload();
  await drawn(page);
  expect(await drums()).toEqual([{ p38: {} }]);
  expect(errors).toEqual([]);
});

test("on drums, Alt+2 then K writes the kick in the second voice, drawn as its own voice; Alt+1 goes back to the first (#45)", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  await page.keyboard.press("Control+ArrowDown");
  for (const key of ["h", "ArrowRight", "h"]) await page.keyboard.press(key);

  await page.keyboard.press("Alt+2");
  expect(await cursorOf(page)).toMatchObject({ voice: "0:1", beatId: null, at: "after" });
  await page.keyboard.press("k");
  /** The pieces of each beat of a voice of the drums' first bar. */
  const voice = async (key: string) => {
    const score = await scoreOf(page);
    return (score.parts[1]!.content[score.bars[0]!.id]?.[key] ?? []).map((beat) => beat.notes);
  };
  expect(await voice("0:1")).toEqual([{ p36: {} }]);
  expect(await voice("0:0")).toEqual([{ p42: {} }, { p42: {} }]);
  expect(await cursorOf(page)).toMatchObject({ voice: "0:1", at: "on", line: DRUM_PIECES.kick.line });
  await drawn(page);
  await expect(page.locator("[data-cursor]")).toBeVisible();

  await page.keyboard.press("Alt+1");
  expect(await cursorOf(page)).toMatchObject({ voice: "0:0", at: "on" });
  await synced(page);
  await page.reload();
  await drawn(page);
  expect(await voice("0:1")).toEqual([{ p36: {} }]);
  expect(errors).toEqual([]);
});
