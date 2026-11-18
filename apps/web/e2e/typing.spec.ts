// Typing on a score the server keeps, in the edit view (#19; docs/spec/views.md, sections 1-4
// and 9). Every key goes through the real keyboard, every click through the real mouse; the page
// is read through `window.__studioTest` and the DOM only.
import { expect, test } from "./test";
import type { Cursor } from "@studio/score-model";
import type { Rect } from "@studio/score-render";

import { overlaps } from "../src/overlay";
import { strings } from "../src/strings";
import { ADMIN, EDITOR, VIEWER } from "./environment";
import { beatsIn, cursorOf, drawn, loggedIn, openScore, pageErrors, scoreOf, seedScore, synced } from "./pages";

/** The beats of the first voice of a bar (by index) of the first part. */
function seed(bars?: number): string {
  return seedScore({
    title: "打譜測試",
    owner: ADMIN.username,
    members: [
      { username: EDITOR.username, role: "editor" },
      { username: VIEWER.username, role: "viewer" },
    ],
    bars,
  });
}

test("an Editor moves with the arrows, types a fret and shortens it; after reloading the score holds both", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  const start = await scoreOf(page);
  expect(await cursorOf(page)).toEqual({ partId: start.parts[0]!.id, barId: start.bars[0]!.id, voice: "0:0", beatId: null, at: "after", line: 1 });

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  expect(await cursorOf(page)).toMatchObject({ barId: start.bars[1]!.id, beatId: null, at: "after", line: 2 });
  await page.keyboard.press("5");
  await page.keyboard.press("+");
  await synced(page);

  await page.reload();
  await drawn(page);
  const typed = beatsIn(await scoreOf(page), 0, 1);
  expect(typed).toHaveLength(1);
  expect(typed[0]).toMatchObject({ value: 8, dots: 0, notes: { s2: { fret: 5 } } });
  expect(errors).toEqual([]);
});

test("a digit in the append slot makes a new beat, and the cursor is on it; another member sees the fret", async ({ browser }) => {
  const id = seed();
  const editor = await loggedIn(browser, EDITOR);
  const owner = await loggedIn(browser, ADMIN);
  const errors = [pageErrors(editor), pageErrors(owner)];
  await openScore(editor, id);
  await openScore(owner, id);

  // The append slot of the empty voice of the first bar.
  await editor.keyboard.press("5");
  const first = beatsIn(await scoreOf(editor), 0, 0);
  expect(first).toHaveLength(1);
  expect(await cursorOf(editor)).toMatchObject({ beatId: first[0]!.id, at: "on" });

  // The append slot after that beat: its anchor is the beat.
  await editor.keyboard.press("ArrowRight");
  expect(await cursorOf(editor)).toMatchObject({ beatId: first[0]!.id, at: "after" });
  await editor.keyboard.press("7");
  const both = beatsIn(await scoreOf(editor), 0, 0);
  expect(both.map((beat) => beat.notes.s1?.fret)).toEqual([5, 7]);
  expect(await cursorOf(editor)).toMatchObject({ beatId: both[1]!.id, at: "on" });
  await synced(editor);

  // The Owner, in a browser context of their own, gets both frets.
  await expect.poll(async () => beatsIn(await scoreOf(owner), 0, 0).map((beat) => beat.notes.s1?.fret)).toEqual([5, 7]);
  expect(errors.flat()).toEqual([]);
});

test("an Editor jumps a bar with Ctrl+→, dots a beat with ., goes back with Home and undoes with Ctrl+Z; Alt+2 on a guitar says it has one voice", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);
  const start = await scoreOf(page);

  await page.keyboard.press("Control+ArrowRight");
  expect(await cursorOf(page)).toMatchObject({ barId: start.bars[1]!.id, beatId: null, at: "after" });
  await page.keyboard.press("3");
  await page.keyboard.press(".");
  await page.keyboard.press("End");
  await page.keyboard.press("Home");
  const beat = beatsIn(await scoreOf(page), 0, 1)[0]!;
  expect(beat).toMatchObject({ value: 4, dots: 1, notes: { s1: { fret: 3 } } });
  expect(await cursorOf(page)).toMatchObject({ barId: start.bars[1]!.id, beatId: beat.id, at: "on" });

  await page.keyboard.press("Control+z");
  expect(beatsIn(await scoreOf(page), 0, 1)[0]).toMatchObject({ dots: 0 });

  const notice = page.getByRole("status").filter({ hasText: strings.score.hints.oneVoice });
  await page.keyboard.press("Alt+2");
  await expect(notice).toBeVisible();
  expect(await cursorOf(page)).toMatchObject({ voice: "0:0", beatId: beat.id });
  await synced(page);
  expect(errors).toEqual([]);
});

test("an Editor bends a note with Shift+B, 2 semitones, takes it a semitone up and down with Shift+↑ and Shift+↓; after reloading the score holds the bend", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);

  await page.keyboard.press("7");
  const bendOf = async () => beatsIn(await scoreOf(page), 0, 0)[0]!.notes.s1;
  expect(await bendOf()).toEqual({ fret: 7 });
  await page.keyboard.press("Shift+B");
  expect(await bendOf()).toEqual({ fret: 7, bend: { type: "bend", semitones: 2 } });
  await page.keyboard.press("Shift+ArrowUp");
  expect(await bendOf()).toEqual({ fret: 7, bend: { type: "bend", semitones: 3 } });
  await page.keyboard.press("Shift+ArrowDown");
  expect(await bendOf()).toEqual({ fret: 7, bend: { type: "bend", semitones: 2 } });
  // The cursor stays on the note and its string: Shift with the arrows is not a move.
  expect(await cursorOf(page)).toMatchObject({ beatId: beatsIn(await scoreOf(page), 0, 0)[0]!.id, at: "on", line: 1 });
  await synced(page);

  await page.reload();
  await drawn(page);
  expect(await bendOf()).toEqual({ fret: 7, bend: { type: "bend", semitones: 2 } });
  expect(errors).toEqual([]);
});

test("an Editor steps a note through the harmonics with Shift+N, each drawn without an error; after reloading the score holds the harmonic", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);

  await page.keyboard.press("1");
  await page.keyboard.press("2");
  const noteOf = async () => beatsIn(await scoreOf(page), 0, 0)[0]!.notes.s1;
  expect(await noteOf()).toEqual({ fret: 12 });
  for (const harmonic of ["natural", "pinch", "artificial"] as const) {
    await page.keyboard.press("Shift+N");
    expect(await noteOf()).toEqual({ fret: 12, harmonic });
    await drawn(page);
  }
  await page.keyboard.press("Shift+N");
  expect(await noteOf()).toEqual({ fret: 12 });
  await page.keyboard.press("Shift+N");
  expect(await noteOf()).toEqual({ fret: 12, harmonic: "natural" });
  await synced(page);

  await page.reload();
  await drawn(page);
  expect(await noteOf()).toEqual({ fret: 12, harmonic: "natural" });
  expect(errors).toEqual([]);
});

test("a Viewer moves the cursor but changes nothing; the notice that a Viewer cannot edit shows only the first time", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, VIEWER);
  const errors = pageErrors(page);
  await openScore(page, id);
  const before = await scoreOf(page);
  const notice = page.getByRole("status").filter({ hasText: strings.score.viewerCannotEdit });

  await page.keyboard.press("5");
  await expect(notice).toBeVisible();
  await page.keyboard.press("+");
  await page.keyboard.press("6");
  await page.getByRole("button", { name: strings.score.dismiss }).click();
  await expect(notice).toHaveCount(0);

  // The score has the keyboard again: more refused keys, then a move that is allowed.
  await page.keyboard.press("7");
  await page.keyboard.press("Delete");
  await page.keyboard.press("ArrowRight");
  expect(await cursorOf(page)).toMatchObject({ barId: before.bars[1]!.id });
  await expect(notice).toHaveCount(0);
  expect(await scoreOf(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test("at the top of a score of more than 10 bars, the cursor never covers an area reserved for the engine's mark", async ({ browser }) => {
  const id = seed(12);
  const page = await loggedIn(browser, ADMIN);
  const errors = pageErrors(page);
  await openScore(page, id);
  const reserved = page.locator("[data-reserved]");
  await expect(reserved).not.toHaveCount(0);
  const scroller = page.locator("[data-scroller]");
  const barIds = (await scoreOf(page)).bars.map((bar) => bar.id);

  /**
   * The cursor is drawn where it is now, clear of every reserved area, with the page at the top;
   * returns where it is drawn. The areas are read again each time: typing lays the system out again.
   */
  async function clearAt(bar: number, at: Cursor["at"]): Promise<Rect> {
    expect(await scroller.evaluate((element) => element.scrollTop)).toBe(0);
    expect(await cursorOf(page)).toMatchObject({ barId: barIds[bar], at, line: 1 });
    const cursor = await page.locator("[data-cursor]").boundingBox();
    expect(cursor).not.toBeNull();
    const areas = await Promise.all((await reserved.all()).map((area) => area.boundingBox()));
    expect(areas.length).toBeGreaterThan(0);
    for (const area of areas) expect(overlaps(cursor!, area!), `bar ${bar + 1}, ${at}`).toBe(false);
    return cursor!;
  }

  // On the top string, the append slot of every empty bar; the first system's bars share a top.
  const tops: number[] = [];
  for (let bar = 0; bar < barIds.length; bar++) {
    tops.push((await clearAt(bar, "after")).y);
    await page.keyboard.press("ArrowRight");
  }
  const lastOfFirstSystem = tops.lastIndexOf(tops[0]!);
  expect(lastOfFirstSystem).toBeLessThan(barIds.length - 1);
  for (let bar = barIds.length - 1; bar > lastOfFirstSystem; bar--) await page.keyboard.press("ArrowLeft");

  // Four beats in that bar, under the mark: each beat, and the append slot after each but the
  // last (the bar is then full, and → goes on to the next bar).
  for (let beat = 1; beat <= 4; beat++) {
    await page.keyboard.press("1");
    await clearAt(lastOfFirstSystem, "on");
    if (beat === 4) break;
    await page.keyboard.press("ArrowRight");
    await clearAt(lastOfFirstSystem, "after");
  }
  expect(beatsIn(await scoreOf(page), 0, lastOfFirstSystem)).toHaveLength(4);
  expect(errors).toEqual([]);
});

test("a click on a beat of the score puts the cursor on that beat", async ({ browser }) => {
  const id = seed();
  const page = await loggedIn(browser, EDITOR);
  const errors = pageErrors(page);
  await openScore(page, id);

  await page.keyboard.press("5");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("7");
  const [first, second] = beatsIn(await scoreOf(page), 0, 0);
  // Where the first beat is drawn: the cursor shows it.
  await page.keyboard.press("ArrowLeft");
  expect(await cursorOf(page)).toMatchObject({ beatId: first!.id, at: "on" });
  const box = (await page.locator("[data-cursor]").boundingBox())!;
  await page.keyboard.press("ArrowRight");
  expect(await cursorOf(page)).toMatchObject({ beatId: second!.id });

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  expect(await cursorOf(page)).toMatchObject({ beatId: first!.id, at: "on", line: 1 });
  expect(errors).toEqual([]);
});
