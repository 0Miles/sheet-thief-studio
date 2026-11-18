// Two members, each logged in in a browser of their own, typing in the same bar of one score at
// the same time, in the edit view (docs/ROADMAP.md, question S4; docs/spec/commands.md, section 2).
// Every key goes through the real keyboard; the pages are read through `window.__studioTest`.
import { expect, type Page, test } from "./test";
import type { BeatJSON, ScoreJSON } from "@studio/score-model";

import { ADMIN, EDITOR } from "./environment";
import { beatsIn, cursorOf, loggedIn, openScore, pageErrors, scoreOf, seedScore, typeBeats } from "./pages";

/** The fourth bar of a new score: empty. */
const BAR = 3;

/** The frets on a string of the beats that have a note there, with where those beats are in the bar. */
function run(beats: BeatJSON[], string: string): { frets: number[]; indexes: number[] } {
  const held = beats.map((beat, index) => ({ fret: beat.notes[string]?.fret, index })).filter((item) => item.fret !== undefined);
  return { frets: held.map((item) => item.fret as number), indexes: held.map((item) => item.index) };
}

function isContiguous(indexes: number[]): boolean {
  return indexes.every((index, at) => at === 0 || index === (indexes[at - 1] as number) + 1);
}

/** Wait until every page has sent its changes and all hold the same score; returns that score. */
async function settled(pages: Page[]): Promise<ScoreJSON> {
  await expect
    .poll(
      async () => {
        const synced = await Promise.all(pages.map((page) => page.locator('[data-sync="synced"]').count()));
        const scores = await Promise.all(pages.map((page) => page.evaluate(() => JSON.stringify(window.__studioTest!.scoreJson()))));
        return synced.every((count) => count === 1) && scores.every((score) => score === scores[0]);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return scoreOf(pages[0]!);
}

/** From where the edit view starts (the first string of the first bar), go to the append slot of the empty fourth bar, on a string. */
async function goToBar(page: Page, string: number): Promise<void> {
  for (let bar = 0; bar < BAR; bar++) await page.keyboard.press("ArrowRight");
  for (let line = 1; line < string; line++) await page.keyboard.press("ArrowDown");
  const score = await scoreOf(page);
  expect(await cursorOf(page)).toMatchObject({ barId: score.bars[BAR]!.id, beatId: null, at: "after", line: string });
}

test("two members typing in the same bar at the same time keep every beat, each run together, and undo only their own", async ({ browser }) => {
  const id = seedScore({ title: "共編測試", owner: ADMIN.username, members: [{ username: EDITOR.username, role: "editor" }] });
  const anna = await loggedIn(browser, ADMIN);
  const ben = await loggedIn(browser, EDITOR);
  const errors = [pageErrors(anna), pageErrors(ben)];
  for (const page of [anna, ben]) await openScore(page, id);
  const start = await settled([anna, ben]);
  expect(start.parts).toHaveLength(1);
  expect(beatsIn(start, 0, BAR)).toHaveLength(0);

  await goToBar(anna, 6);
  await goToBar(ben, 1);
  const annaFrets = [1, 2, 3, 4, 5, 6];
  const benFrets = [7, 8, 9, 7, 8, 9];
  await Promise.all([typeBeats(anna, annaFrets), typeBeats(ben, benFrets)]);

  const typed = beatsIn(await settled([anna, ben]), 0, BAR);
  expect(typed).toHaveLength(annaFrets.length + benFrets.length);
  expect(new Set(typed.map((beat) => beat.id)).size).toBe(typed.length);
  const annaRun = run(typed, "s6");
  const benRun = run(typed, "s1");
  expect(annaRun.frets).toEqual(annaFrets);
  expect(benRun.frets).toEqual(benFrets);
  expect(isContiguous(annaRun.indexes)).toBe(true);
  expect(isContiguous(benRun.indexes)).toBe(true);

  // Anna takes back her last beat (typed in the append slot: the beat and its fret are one step): Ben's beats are untouched.
  await anna.keyboard.press("Control+z");
  const afterAnna = beatsIn(await settled([anna, ben]), 0, BAR);
  expect(run(afterAnna, "s6").frets).toEqual(annaFrets.slice(0, -1));
  expect(run(afterAnna, "s1").frets).toEqual(benFrets);
  expect(afterAnna).toHaveLength(typed.length - 1);

  // And Ben his: Anna's remaining beats are untouched.
  await ben.keyboard.press("Control+z");
  const afterBen = beatsIn(await settled([anna, ben]), 0, BAR);
  expect(run(afterBen, "s6").frets).toEqual(annaFrets.slice(0, -1));
  expect(run(afterBen, "s1").frets).toEqual(benFrets.slice(0, -1));
  expect(afterBen).toHaveLength(typed.length - 2);

  // Redo brings Anna's beat back without disturbing Ben's.
  await anna.keyboard.press("Control+y");
  const redone = beatsIn(await settled([anna, ben]), 0, BAR);
  expect(run(redone, "s6").frets).toEqual(annaFrets);
  expect(run(redone, "s1").frets).toEqual(benFrets.slice(0, -1));
  expect(isContiguous(run(redone, "s6").indexes)).toBe(true);

  expect(errors.flat()).toEqual([]);
});
