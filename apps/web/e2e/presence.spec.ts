// The presence (#34; docs/spec/views.md, sections 8 and 9): members see each other's cursors and
// name tags, follow them as they move, find them again after a change that takes their anchors
// away, and see who is reading without a cursor. Every key goes through the real keyboard; the
// pages are read through the DOM and `window.__studioTest`.
import { type BrowserContextOptions, expect, type Page, test } from "./test";

import { overlaps } from "../src/overlay";
import { ADMIN, EDITOR, VIEWER } from "./environment";
import { beatsIn, cursorOf, loggedIn, openScore, pageErrors, scoreOf, seedScore, synced } from "./pages";

/** A phone held upright: the Read view. */
const PHONE: BrowserContextOptions = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true };

/** A score of the admin's with the Editor a member of it. */
function seed(title: string, bars?: number): string {
  return seedScore({ title, owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }], bars });
}

const peerCursors = (page: Page) => page.locator("[data-peer-cursor]");
const nameTags = (page: Page) => page.locator("[data-name-tag]");
const members = (page: Page) => page.locator("[data-member]");

test("a member sees another's cursor and name tag and follows it; two tabs of one member are one member with two cursors", async ({ browser }) => {
  const id = seed("在場測試");
  const ben = await loggedIn(browser, ADMIN);
  const anna = await loggedIn(browser, EDITOR);
  const errors = [pageErrors(ben), pageErrors(anna)];
  await openScore(ben, id);
  await openScore(anna, id);
  const barIds = (await scoreOf(ben)).bars.map((bar) => bar.id);

  await expect(peerCursors(ben)).toHaveCount(1);
  await expect(peerCursors(ben)).toHaveAttribute("data-bar", barIds[0]!);
  await expect(peerCursors(ben)).toHaveAttribute("data-mode", "edit");
  await expect(nameTags(ben)).toHaveText(EDITOR.displayName);
  await expect(members(ben)).toHaveCount(1);
  await expect(members(ben)).toContainText(EDITOR.displayName);
  await expect(members(ben)).toHaveAttribute("data-mode", "edit");
  const before = (await peerCursors(ben).boundingBox())!;

  await anna.keyboard.press("Control+ArrowRight");
  await expect(peerCursors(ben)).toHaveAttribute("data-bar", barIds[1]!);
  const after = (await peerCursors(ben).boundingBox())!;
  expect(after.x).toBeGreaterThan(before.x);
  // The name tag goes with the cursor.
  expect(Math.abs((await nameTags(ben).boundingBox())!.x - after.x)).toBeLessThan(1);

  // A second tab of Anna's: two cursors, one Anna in the list.
  const second = await anna.context().newPage();
  errors.push(pageErrors(second));
  await openScore(second, id);
  await expect(peerCursors(ben)).toHaveCount(2);
  await expect(nameTags(ben)).toHaveText([EDITOR.displayName, EDITOR.displayName]);
  await expect(members(ben)).toHaveCount(1);
  // Anna's tabs list Ben, not Anna, and see each other's cursor.
  await expect(members(anna)).toHaveCount(1);
  await expect(members(anna)).toContainText(ADMIN.displayName);
  await expect(peerCursors(anna)).toHaveCount(2);

  // A tab that closes takes its cursor along.
  await second.close();
  await expect(peerCursors(ben)).toHaveCount(1);
  await expect(members(ben)).toHaveCount(1);
  for (const each of errors) expect(each).toEqual([]);
});

test("when one member deletes the beat, then the bar, another's cursor is on, its cursor lands on a reasonable place there too", async ({ browser }) => {
  const id = seed("在場與刪除");
  const ben = await loggedIn(browser, ADMIN);
  const anna = await loggedIn(browser, EDITOR);
  const errors = [pageErrors(ben), pageErrors(anna)];
  await openScore(ben, id);
  await openScore(anna, id);
  const barIds = (await scoreOf(ben)).bars.map((bar) => bar.id);

  // Ben types three quarter beats in the first bar and goes back to the second.
  for (const [index, fret] of [1, 2, 3].entries()) {
    if (index > 0) await ben.keyboard.press("ArrowRight");
    await ben.keyboard.press(String(fret));
  }
  await ben.keyboard.press("ArrowLeft");
  await synced(ben);
  const typed = beatsIn(await scoreOf(ben), 0, 0).map((beat) => beat.id);
  expect(typed).toHaveLength(3);
  await expect(peerCursors(anna)).toHaveAttribute("data-beat", typed[1]!);

  // Anna deletes that beat: its note, then the rest left.
  await expect.poll(async () => beatsIn(await scoreOf(anna), 0, 0).length).toBe(3);
  await anna.keyboard.press("Home");
  await anna.keyboard.press("ArrowRight");
  expect(await cursorOf(anna)).toMatchObject({ beatId: typed[1], at: "on" });
  await anna.keyboard.press("Delete");
  await anna.keyboard.press("Delete");
  expect(beatsIn(await scoreOf(anna), 0, 0).map((beat) => beat.id)).toEqual([typed[0], typed[2]]);
  // On Anna's page Ben's cursor is on the beat that took its place, as it is on his.
  await expect(peerCursors(anna)).toHaveCount(1);
  await expect(peerCursors(anna)).toHaveAttribute("data-beat", typed[2]!);
  await expect.poll(() => cursorOf(ben)).toMatchObject({ beatId: typed[2] });

  // Anna deletes the bar: Ben's cursor goes to the start of the score, on both pages.
  await anna.keyboard.press("Control+Delete");
  await expect.poll(async () => (await scoreOf(anna)).bars.map((bar) => bar.id)).toEqual(barIds.slice(1));
  await expect(peerCursors(anna)).toHaveAttribute("data-bar", barIds[1]!);
  await expect.poll(() => cursorOf(ben)).toMatchObject({ barId: barIds[1] });
  for (const each of errors) expect(each).toEqual([]);
});

test("a Viewer's cursor is pale on their own page, and in read mode, pale, on the others'", async ({ browser }) => {
  const id = seedScore({ title: "在場與檢視者", owner: ADMIN.username, members: [{ username: VIEWER.username, role: "viewer" }] });
  const ben = await loggedIn(browser, ADMIN);
  const dan = await loggedIn(browser, VIEWER);
  const errors = [pageErrors(ben), pageErrors(dan)];
  await openScore(ben, id);
  await openScore(dan, id);
  await expect(dan.locator("main")).toHaveAttribute("data-view", "readOnlyEdit");
  // Their own cursor: the read-only edit view's pale one (#19).
  await expect(dan.locator("[data-cursor]")).toHaveClass(/score__cursor--read/);
  // The Owner's own cursor is not.
  await expect(ben.locator("[data-cursor]")).not.toHaveClass(/score__cursor--read/);

  await expect(peerCursors(ben)).toHaveCount(1);
  await expect(peerCursors(ben)).toHaveAttribute("data-mode", "read");
  await expect(peerCursors(ben)).toHaveClass(/score__peer-cursor--read/);
  await expect(members(ben)).toHaveAttribute("data-mode", "read");
  // The Viewer sees the Owner, typing.
  await expect(peerCursors(dan)).toHaveAttribute("data-mode", "edit");
  for (const each of errors) expect(each).toEqual([]);
});

test("a member reading on a phone is in the others' list of members, with no cursor", async ({ browser }) => {
  const id = seed("在場與看譜");
  const ben = await loggedIn(browser, ADMIN);
  const anna = await loggedIn(browser, EDITOR, PHONE);
  const errors = [pageErrors(ben), pageErrors(anna)];
  await openScore(ben, id);
  await openScore(anna, id);
  await expect(anna.locator("main")).toHaveAttribute("data-view", "read");

  await expect(members(ben)).toHaveCount(1);
  await expect(members(ben)).toContainText(EDITOR.displayName);
  await expect(members(ben)).toHaveAttribute("data-mode", "read");
  // Ben's cursor moves, and still none of Anna's is drawn on his page.
  await ben.keyboard.press("Control+ArrowRight");
  await synced(ben);
  await expect(peerCursors(ben)).toHaveCount(0);
  await expect(nameTags(ben)).toHaveCount(0);
  for (const each of errors) expect(each).toEqual([]);
});

test("scrolled to the top, another member's cursor and name tag keep clear of the reserved areas, on every bar", async ({ browser }) => {
  // More than 10 bars: the reserved area is there.
  const id = seed("在場與標記", 12);
  const ben = await loggedIn(browser, ADMIN);
  const anna = await loggedIn(browser, EDITOR);
  const errors = [pageErrors(ben), pageErrors(anna)];
  await openScore(ben, id);
  await openScore(anna, id);
  const reserved = ben.locator("[data-reserved]");
  await expect(reserved).not.toHaveCount(0);
  const areas = await Promise.all((await reserved.all()).map((area) => area.boundingBox()));
  const barIds = (await scoreOf(ben)).bars.map((bar) => bar.id);
  const scroller = ben.locator("[data-scroller]");

  let movedBelow = 0;
  for (const [index, barId] of barIds.entries()) {
    if (index > 0) await anna.keyboard.press("Control+ArrowRight");
    await expect(peerCursors(ben)).toHaveAttribute("data-bar", barId);
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
    const cursor = (await peerCursors(ben).boundingBox())!;
    const tag = (await nameTags(ben).boundingBox())!;
    for (const area of areas) {
      expect(overlaps(cursor, area!), `the cursor in bar ${index + 1}`).toBe(false);
      expect(overlaps(tag, area!), `the name tag in bar ${index + 1}`).toBe(false);
    }
    if (tag.y > cursor.y) movedBelow += 1;
  }
  // Under the mark, the name tag went below the cursor rather than over the mark.
  expect(movedBelow).toBeGreaterThan(0);
  for (const each of errors) expect(each).toEqual([]);
});
