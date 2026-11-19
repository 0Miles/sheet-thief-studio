// S2: how long an edit takes to reach the page in the edit view, on a score of 100 bars and 5
// parts, plain or with techniques. Three measurements, 50 runs each, for an edit in bar 3, 50 and
// 98, showing one part or all five:
//  - stages: reading the document (`readScore`: schema checks and the cache of checked beats),
//    finding the flags of the whole score (`flagsOf`), the projection, alphaTab's finish(), and
//    drawing up to the renderer's "rendered" event;
//  - keys: a real key press to the frame after the changed bar and the cursor were painted;
//  - keys while another member edits: the same, with a second client, logged in as an Editor of
//    the score, changing a fret of the part shown in some other bar every 250 ms meanwhile.
// The edit view lays out on the page's own thread and replaces the changed bars in alphaTab's
// model (docs/adr/0003): the one strategy M0 chose, measured as members get it, player and all.
// Every browser has a project (playwright.measure.config.ts); results are named after it.
import { type Browser, expect, type Page, test } from "@playwright/test";

import type { KeySample, RenderSample } from "../../src/measureHook";
import { EDITOR } from "../environment";
import { logInFromStart } from "../pages";
import { logInAsAdmin, median, openEditView, p95, placeCursor, runs } from "./editView";
import { browserOf, environment, MILESTONE, MODE, writeData, writeText } from "./output";
import { perfScore, type SeededScore } from "./scores";

const RUNS = runs(50);
/** Pause between two edits of the stage measurement, in milliseconds. */
const IDLE = 120;
/** Pause between two edits of the other member, in milliseconds. */
const OTHER_EVERY = 250;
/** Bar 3, 50 and 98, by index. */
const BARS = [2, 49, 97];
/** The part that is edited, and the one shown alone: Guitar 1. */
const PART = 0;
/** The first keys of a cell warm the path up and are left out. */
const WARM_UP = 3;

const SHOWN = [
  { id: "one", label: "1 part", only: PART },
  { id: "five", label: "5 parts", only: undefined },
];

interface Cell<T> {
  score: string;
  shown: string;
  bar: number;
  samples: T[];
}

const ms = (value: number): string => value.toFixed(1);
const stat = (values: number[]): string => (values.length === 0 ? "—" : `${ms(median(values))} / ${ms(p95(values))}`);

let scores: { id: string; score: SeededScore }[];

test.beforeAll(() => {
  scores = [
    { id: "plain", score: perfScore() },
    { id: "techniques", score: perfScore(100, { techniques: true }) },
  ];
});

test.beforeEach(async ({ page }) => {
  await logInAsAdmin(page);
});

test("stages of an edit", async ({ page }) => {
  const cells: Cell<RenderSample>[] = [];
  for (const { id, score } of scores) {
    for (const shown of SHOWN) {
      await openEditView(page, score, shown.only);
      // A few edits first: the first ones pay for code that has not run yet.
      for (let i = 0; i < 5; i++) await page.evaluate((part) => window.__studioMeasure!.editBar(part, 10), PART);
      for (const bar of BARS) {
        const samples: RenderSample[] = [];
        for (let i = 0; i < RUNS; i++) {
          samples.push(await page.evaluate(([part, at]) => window.__studioMeasure!.editBar(part!, at!), [PART, bar]));
          // Let the pieces on screen be painted before the next edit: each one starts from rest.
          await page.waitForTimeout(IDLE);
        }
        // Every edit after the first lays out only from the changed bar on.
        expect(samples.filter((sample) => sample.partial).length).toBeGreaterThanOrEqual(RUNS - 1);
        cells.push({ score: id, shown: shown.id, bar: bar + 1, samples });
      }
      await expectNoErrors(page);
    }
  }
  const rows = cells.map((cell) => {
    const column = (key: keyof RenderSample): number[] => cell.samples.map((sample) => sample[key] as number);
    return `| ${cell.score} | ${cell.shown} | ${cell.bar} | ${stat(column("toJson"))} | ${stat(column("flags"))} | ${stat(column("project"))} | ${stat(column("finish"))} | ${stat(column("render"))} | ${stat(column("total"))} |`;
  });
  const table = ["| score | shown | bar | readScore | flagsOf | projection | finish() | render → rendered | total |", "|---|---|---|---|---|---|---|---|---|", ...rows].join("\n");
  const name = `${MILESTONE}-s2-stages-${browserOf(page)}-${MODE}`;
  const flags = Object.fromEntries(scores.map(({ id, score }) => [id, score.flags]));
  writeData(`${name}.json`, { environment: await environment(page), runs: RUNS, restBetweenEditsMs: IDLE, flags, cells });
  writeText(`${name}.md`, `Median / p95 in milliseconds, ${RUNS} runs per row, ${IDLE} ms of rest between edits (${browserOf(page)}, ${MODE}). Flags in the scores as written: ${JSON.stringify(flags)}.\n\n${table}\n`);
  console.log(table);
});

test("key press to painted frame", async ({ page }) => {
  const cells: Cell<KeySample>[] = [];
  for (const { id, score } of scores) {
    for (const shown of SHOWN) {
      await openEditView(page, score, shown.only);
      for (const bar of BARS) cells.push({ score: id, shown: shown.id, bar: bar + 1, samples: await typeIn(page, bar) });
      await expectNoErrors(page);
    }
  }
  const name = `${MILESTONE}-s2-keys-${browserOf(page)}-${MODE}`;
  writeData(`${name}.json`, { environment: await environment(page), runs: RUNS, cells });
  writeText(`${name}.md`, `Milliseconds since the key press, median / p95, ${RUNS} keys per row (${browserOf(page)}, ${MODE}).\n\n${keyTable(cells)}\n`);
  console.log(keyTable(cells));
});

test("key press to painted frame while another member edits", async ({ page, browser }) => {
  const { id, score } = scores[0]!;
  const other = await otherMember(browser, score);
  const cells: (Cell<KeySample> & { otherEdits: number; otherEditsPerSecond: number; drawingsSeen: number })[] = [];
  for (const shown of SHOWN) {
    await openEditView(page, score, shown.only);
    for (const bar of BARS) {
      const drawingsBefore = await page.evaluate(() => window.__studioMeasure!.renders.length);
      const editing = keepEditing(other, bar);
      const samples = await typeIn(page, bar);
      const { edits, seconds } = await editing.stop();
      const drawingsSeen = (await page.evaluate(() => window.__studioMeasure!.renders.length)) - drawingsBefore;
      cells.push({ score: id, shown: shown.id, bar: bar + 1, samples, otherEdits: edits, otherEditsPerSecond: edits / seconds, drawingsSeen });
    }
    await expectNoErrors(page);
  }
  await expectNoErrors(other);
  await other.context().close();
  const name = `${MILESTONE}-s2-concurrent-${browserOf(page)}-${MODE}`;
  const rate = cells.map((cell) => `bar ${cell.bar} (${cell.shown}): ${cell.otherEditsPerSecond.toFixed(1)} edits/s, ${cell.drawingsSeen} drawings`).join("; ");
  writeData(`${name}.json`, { environment: await environment(page), runs: RUNS, otherEveryMs: OTHER_EVERY, cells });
  writeText(`${name}.md`, `Milliseconds since the key press, median / p95, ${RUNS} keys per row, while an Editor changes a fret of Guitar 1 in another bar every ${OTHER_EVERY} ms (${browserOf(page)}, ${MODE}). Other member: ${rate}.\n\n${keyTable(cells)}\n`);
  console.log(keyTable(cells));
});

/**
 * Type RUNS keys (and WARM_UP more first) on the first beat of a bar of the part edited, as fast
 * as a quick typist and as slowly as a pause: 150 to 650 ms apart. Returns the samples in the
 * order the keys were pressed, the warm-up left out.
 */
async function typeIn(page: Page, bar: number): Promise<KeySample[]> {
  let state = 11;
  const pause = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return 150 + (state % 500);
  };
  await placeCursor(page, PART, bar, 0, 2);
  await page.waitForTimeout(500);
  const before = await page.evaluate(() => window.__studioMeasure!.keys.length);
  // 7, 8, 9 in turn: each is a fret of its own (78 is no fret), so every key is one edit.
  for (let i = 0; i < RUNS + WARM_UP; i++) {
    await page.keyboard.press(String(7 + (i % 3)));
    await page.waitForTimeout(pause());
  }
  await page.waitForTimeout(1700);
  // Samples are kept as each key is settled, which need not be the order they were pressed in.
  const all = (await page.evaluate((from) => window.__studioMeasure!.keys.slice(from), before)).sort((a, b) => a.pressed - b.pressed);
  const samples = all.slice(WARM_UP);
  expect(samples).toHaveLength(RUNS);
  return samples;
}

function keyTable(cells: Cell<KeySample>[]): string {
  const rows = cells.map((cell) => {
    const painted = cell.samples.filter((sample) => sample.painted !== null && sample.rendered !== null);
    const since = (key: "started" | "handled" | "rendered" | "painted" | "frame" | "nextFrame"): number[] => painted.map((sample) => (sample[key] as number) - sample.pressed);
    return `| ${cell.score} | ${cell.shown} | ${cell.bar} | ${stat(since("started"))} | ${stat(since("handled"))} | ${stat(since("rendered"))} | ${stat(since("painted"))} | ${stat(since("frame"))} | ${stat(since("nextFrame"))} | ${cell.samples.length - painted.length} |`;
  });
  return ["| score | shown | bar | handler starts | command done | rendered | bar painted | first frame | frame after | not painted |", "|---|---|---|---|---|---|---|---|---|---|", ...rows].join("\n");
}

/** The other member: an Editor of the score, in a browser context of its own, in the edit view showing the part edited. */
async function otherMember(browser: Browser, score: SeededScore): Promise<Page> {
  const { baseURL, viewport, deviceScaleFactor, userAgent } = test.info().project.use;
  const context = await browser.newContext({ baseURL, viewport, deviceScaleFactor, userAgent });
  const page = await context.newPage();
  await logInFromStart(page, EDITOR);
  await openEditView(page, score, PART);
  return page;
}

/**
 * Have the other member change a fret of the part edited every OTHER_EVERY ms, in bars spread over
 * the score but never `bar`, where the keys are typed, until stopped.
 */
function keepEditing(other: Page, bar: number): { stop(): Promise<{ edits: number; seconds: number }> } {
  let editing = true;
  let edits = 0;
  let state = 5 + bar;
  const started = Date.now();
  const done = (async () => {
    while (editing) {
      state = (state * 1664525 + 1013904223) >>> 0;
      const at = (bar + 1 + (state % 99)) % 100;
      await other.evaluate(([part, where]) => window.__studioMeasure!.editBar(part!, where!), [PART, at]);
      edits += 1;
      await other.waitForTimeout(OTHER_EVERY);
    }
  })();
  return {
    async stop() {
      editing = false;
      await done;
      return { edits, seconds: (Date.now() - started) / 1000 };
    },
  };
}

async function expectNoErrors(page: Page): Promise<void> {
  expect(await page.evaluate(() => window.__studioMeasure!.errors)).toEqual([]);
}
