// Two browsers, each logged in on its own, co-editing one score through the real server on the
// spike page (docs/ROADMAP.md, question S4). Both are the score's Owner: adding members comes with #13.
import { expect, type Page, test } from "@playwright/test";

import { ADMIN } from "./environment";
import { createScore, loggedIn } from "./pages";
import { beatsIn, openScore, placeCursor, settled } from "./studio";

const GUITAR = 0;
/** The fourth bar of a new score: empty. */
const BAR = 3;

/** Type one beat per fret: a new beat, then its fret, as someone entering notes does. */
async function typeBeats(page: Page, frets: number[]): Promise<void> {
  for (const fret of frets) {
    await page.keyboard.press("Insert");
    await page.keyboard.press(String(fret));
    await page.waitForTimeout(20);
  }
}

/** The frets on a string of the beats that have a note there, with where those beats are in the bar. */
function run(beats: ReturnType<typeof beatsIn>, string: string): { frets: number[]; indexes: number[] } {
  const held = beats.map((beat, index) => ({ fret: beat.notes[string]?.fret, index })).filter((item) => item.fret !== undefined);
  return { frets: held.map((item) => item.fret as number), indexes: held.map((item) => item.index) };
}

function isContiguous(indexes: number[]): boolean {
  return indexes.every((index, at) => at === 0 || index === (indexes[at - 1] as number) + 1);
}

test("two members typing in the same bar at the same time keep every beat, each run together, and undo only their own", async ({ browser }) => {
  const anna = await loggedIn(browser, ADMIN);
  const ben = await loggedIn(browser, ADMIN);
  const id = await createScore(anna, "共編測試");
  for (const page of [anna, ben]) await openScore(page, `/spike/${id}?player=0`);
  const start = await settled([anna, ben]);
  expect(start.parts).toHaveLength(1);
  expect(beatsIn(start, GUITAR, BAR)).toHaveLength(0);

  await placeCursor(anna, GUITAR, BAR, -1, 6);
  await placeCursor(ben, GUITAR, BAR, -1, 1);
  const annaFrets = [1, 2, 3, 4, 5, 6];
  const benFrets = [7, 8, 9, 7, 8, 9];
  await Promise.all([typeBeats(anna, annaFrets), typeBeats(ben, benFrets)]);

  const typed = beatsIn(await settled([anna, ben]), GUITAR, BAR);
  expect(typed).toHaveLength(annaFrets.length + benFrets.length);
  expect(new Set(typed.map((beat) => beat.id)).size).toBe(typed.length);
  const annaRun = run(typed, "s6");
  const benRun = run(typed, "s1");
  expect(annaRun.frets).toEqual(annaFrets);
  expect(benRun.frets).toEqual(benFrets);
  expect(isContiguous(annaRun.indexes)).toBe(true);
  expect(isContiguous(benRun.indexes)).toBe(true);

  // Anna takes back her last beat (its fret, then the beat): Ben's beats are untouched.
  await anna.keyboard.press("Control+z");
  await anna.keyboard.press("Control+z");
  const afterAnna = beatsIn(await settled([anna, ben]), GUITAR, BAR);
  expect(run(afterAnna, "s6").frets).toEqual(annaFrets.slice(0, -1));
  expect(run(afterAnna, "s1").frets).toEqual(benFrets);
  expect(afterAnna).toHaveLength(typed.length - 1);

  // And Ben his: Anna's remaining beats are untouched.
  await ben.keyboard.press("Control+z");
  await ben.keyboard.press("Control+z");
  const afterBen = beatsIn(await settled([anna, ben]), GUITAR, BAR);
  expect(run(afterBen, "s6").frets).toEqual(annaFrets.slice(0, -1));
  expect(run(afterBen, "s1").frets).toEqual(benFrets.slice(0, -1));
  expect(afterBen).toHaveLength(typed.length - 2);

  // Redo brings Anna's beat back without disturbing Ben's.
  await anna.keyboard.press("Control+y");
  await anna.keyboard.press("Control+y");
  const redone = beatsIn(await settled([anna, ben]), GUITAR, BAR);
  expect(run(redone, "s6").frets).toEqual(annaFrets);
  expect(run(redone, "s1").frets).toEqual(benFrets.slice(0, -1));
  expect(isContiguous(run(redone, "s6").indexes)).toBe(true);

  for (const page of [anna, ben]) expect(await page.evaluate(() => window.__studio!.errors)).toEqual([]);
});
