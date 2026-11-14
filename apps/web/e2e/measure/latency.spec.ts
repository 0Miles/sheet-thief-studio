// S2: how long an edit takes to reach the page in the edit view, on a score of 100 bars and 5
// parts. Two measurements, 50 runs each, for an edit in bar 3, 50 and 98, showing one part or all
// five:
//  - stages: reading the document, the projection, alphaTab's finish(), and drawing up to the
//    renderer's "rendered" event;
//  - keys: a real key press to the frame after the changed bar and the cursor were painted.
// The edit view lays out on the page's own thread and replaces the changed bars in alphaTab's
// model (docs/adr/0003): the one strategy M0 chose, measured as members get it, player and all.
import { expect, type Page, test } from "@playwright/test";

import type { KeySample, RenderSample } from "../../src/measureHook";
import { logInAsAdmin, median, openEditView, p95, placeCursor, runs } from "./editView";
import { environment, MODE, writeData, writeText } from "./output";
import { perfScore } from "./scores";

const RUNS = runs(50);
/** Pause between two edits of the stage measurement, in milliseconds. */
const IDLE = 120;
/** Bar 3, 50 and 98, by index. */
const BARS = [2, 49, 97];
/** The part that is edited, and the one shown alone: Guitar 1. */
const PART = 0;

const SHOWN = [
  { id: "one", label: "1 part", only: PART },
  { id: "five", label: "5 parts", only: undefined },
];

interface Cell<T> {
  shown: string;
  bar: number;
  samples: T[];
}

const ms = (value: number): string => value.toFixed(1);
const stat = (values: number[]): string => `${ms(median(values))} / ${ms(p95(values))}`;

let scoreId = "";

test.beforeAll(() => {
  scoreId = perfScore();
});

test.beforeEach(async ({ page }) => {
  await logInAsAdmin(page);
});

test("stages of an edit", async ({ page }) => {
  const cells: Cell<RenderSample>[] = [];
  for (const shown of SHOWN) {
    await openEditView(page, scoreId, shown.only);
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
      cells.push({ shown: shown.id, bar: bar + 1, samples });
    }
    await expectNoErrors(page);
  }
  const rows = cells.map((cell) => {
    const column = (key: keyof RenderSample): number[] => cell.samples.map((sample) => sample[key] as number);
    return `| ${cell.shown} | ${cell.bar} | ${stat(column("toJson"))} | ${stat(column("project"))} | ${stat(column("finish"))} | ${stat(column("render"))} | ${stat(column("total"))} |`;
  });
  const table = ["| shown | bar | docToJson | projection | finish() | render → rendered | total |", "|---|---|---|---|---|---|---|", ...rows].join("\n");
  writeData(`s2-stages-${MODE}.json`, { environment: await environment(page), runs: RUNS, restBetweenEditsMs: IDLE, cells });
  writeText(`s2-stages-${MODE}.md`, `Median / p95 in milliseconds, ${RUNS} runs per row, ${IDLE} ms of rest between edits (${MODE}).\n\n${table}\n`);
  console.log(table);
});

test("key press to painted frame", async ({ page }) => {
  const cells: Cell<KeySample>[] = [];
  // Keys arrive as fast as a quick typist and as slowly as a pause: 150 to 650 ms apart.
  let state = 11;
  const pause = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return 150 + (state % 500);
  };
  for (const shown of SHOWN) {
    await openEditView(page, scoreId, shown.only);
    for (const bar of BARS) {
      await placeCursor(page, PART, bar, 0, 2);
      await page.waitForTimeout(500);
      const before = await page.evaluate(() => window.__studioMeasure!.keys.length);
      // 7, 8, 9 in turn: each is a fret of its own (78 is no fret), so every key is one edit.
      for (let i = 0; i < RUNS + 3; i++) {
        await page.keyboard.press(String(7 + (i % 3)));
        await page.waitForTimeout(pause());
      }
      await page.waitForTimeout(1700);
      const all = await page.evaluate((from) => window.__studioMeasure!.keys.slice(from), before);
      // The first three keys warm the path up and are left out.
      const samples = all.slice(3);
      expect(samples).toHaveLength(RUNS);
      cells.push({ shown: shown.id, bar: bar + 1, samples });
    }
    await expectNoErrors(page);
  }
  const rows = cells.map((cell) => {
    const painted = cell.samples.filter((sample) => sample.painted !== null && sample.rendered !== null);
    const since = (key: "started" | "handled" | "rendered" | "painted" | "frame" | "nextFrame"): number[] => painted.map((sample) => (sample[key] as number) - sample.pressed);
    return `| ${cell.shown} | ${cell.bar} | ${stat(since("started"))} | ${stat(since("handled"))} | ${stat(since("rendered"))} | ${stat(since("painted"))} | ${stat(since("frame"))} | ${stat(since("nextFrame"))} | ${cell.samples.length - painted.length} |`;
  });
  const table = ["| shown | bar | handler starts | command done | rendered | bar painted | first frame | frame after | not painted |", "|---|---|---|---|---|---|---|---|---|", ...rows].join("\n");
  writeData(`s2-keys-${MODE}.json`, { environment: await environment(page), runs: RUNS, cells });
  writeText(`s2-keys-${MODE}.md`, `Milliseconds since the key press, median / p95, ${RUNS} keys per row (${MODE}).\n\n${table}\n`);
  console.log(table);
});

async function expectNoErrors(page: Page): Promise<void> {
  expect(await page.evaluate(() => window.__studioMeasure!.errors)).toEqual([]);
}
