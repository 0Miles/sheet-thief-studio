// S2: how long an edit takes to reach the page on a score of 100 bars and 5 parts.
// Two measurements, 50 runs each, for an edit in bar 3, 50 and 98, showing one part or all five:
//  - stages: reading the document, the projection, alphaTab's finish(), and drawing up to the
//    renderer's "rendered" event (player off, so that nothing else runs);
//  - keys: a real key press to the frame after the changed bar and the cursor were painted
//    (player on, as in use).
import { expect, type Page, test } from "@playwright/test";

import type { KeySample, RenderSample } from "../../src/spike/hook";
import { median, openScore, p95, placeCursor } from "../studio";
import { environment, MODE, writeData, writeText } from "./output";

const RUNS = 50;
/** Pause between two edits of the stage measurement, in milliseconds. */
const IDLE = 120;
/** Bar 3, 50 and 98, by index. */
const BARS = [2, 49, 97];
/** The part that is edited, and the one shown alone: Guitar 1. */
const PART = 0;

const SHOWN = [
  { id: "one", label: "1 part", query: `show=${PART}` },
  { id: "five", label: "5 parts", query: "" },
];

/** How the page brings a change to alphaTab. */
const STRATEGIES = [
  { id: "project+hint", label: "whole projection, firstChangedMasterBar", query: "patch=project" },
  { id: "project", label: "whole projection, no hint", query: "patch=project&partial=0" },
  { id: "replace+hint", label: "changed bar replaced in the model, firstChangedMasterBar", query: "patch=replace" },
  { id: "replace", label: "changed bar replaced in the model, no hint", query: "patch=replace&partial=0" },
  { id: "replace+hint, no worker", label: "changed bar replaced, firstChangedMasterBar, drawn on the page's thread", query: "patch=replace&workers=0" },
];
const KEY_STRATEGIES = STRATEGIES.filter((item) => ["project+hint", "replace+hint", "replace+hint, no worker"].includes(item.id));

interface Cell<T> {
  strategy: string;
  shown: string;
  bar: number;
  samples: T[];
}

const ms = (value: number): string => value.toFixed(1);
const stat = (values: number[]): string => `${ms(median(values))} / ${ms(p95(values))}`;

/** The fallback of S2: only a window of 16 bars around the edit is drawn. */
const WINDOW_STRATEGIES = [
  { id: "replace+hint, 16 bars", label: "changed bar replaced, firstChangedMasterBar, only 16 bars drawn", query: "patch=replace&window=16" },
  { id: "replace+hint, 16 bars, no worker", label: "the same, drawn on the page's thread", query: "patch=replace&window=16&workers=0" },
];

test("stages of an edit", async ({ page }) => {
  await stages(page, STRATEGIES, "s2-stages");
});

test("stages of an edit with a window of bars", async ({ page }) => {
  await stages(page, WINDOW_STRATEGIES, "s2-window");
});

async function stages(page: Page, strategies: { id: string; label: string; query: string }[], file: string): Promise<void> {
  const cells: Cell<RenderSample>[] = [];
  for (const strategy of strategies) {
    for (const shown of SHOWN) {
      await openScore(page, `/local?seed=perf&player=0&${strategy.query}&${shown.query}`);
      // A few edits first: the first ones pay for code that has not run yet.
      for (let i = 0; i < 5; i++) await page.evaluate((part) => window.__studio!.editBar(part, 10), PART);
      for (const bar of BARS) {
        const samples: RenderSample[] = [];
        for (let i = 0; i < RUNS; i++) {
          samples.push(await page.evaluate(([part, at]) => window.__studio!.editBar(part!, at!), [PART, bar]));
          // Let the pieces on screen be painted before the next edit: each one starts from rest.
          await page.waitForTimeout(IDLE);
        }
        const hinted = strategy.query.includes("partial=0") === false;
        // With a window, the first edit in a new place moves the window and is laid out whole.
        const partial = samples.filter((sample) => sample.partial).length;
        expect(partial).toBeGreaterThanOrEqual(hinted ? RUNS - 1 : 0);
        expect(partial).toBeLessThanOrEqual(hinted ? RUNS : 0);
        cells.push({ strategy: strategy.id, shown: shown.id, bar: bar + 1, samples });
      }
      expect(await page.evaluate(() => window.__studio!.errors)).toEqual([]);
    }
  }
  const rows = cells.map((cell) => {
    const column = (key: keyof RenderSample): number[] => cell.samples.map((sample) => sample[key] as number);
    return `| ${cell.strategy} | ${cell.shown} | ${cell.bar} | ${stat(column("toJson"))} | ${stat(column("project"))} | ${stat(column("finish"))} | ${stat(column("render"))} | ${stat(column("total"))} |`;
  });
  const table = ["| strategy | shown | bar | docToJson | projection | finish() | render → rendered | total |", "|---|---|---|---|---|---|---|---|", ...rows].join("\n");
  writeData(`${file}-${MODE}.json`, { environment: await environment(page), runs: RUNS, restBetweenEditsMs: IDLE, strategies, cells });
  writeText(`${file}-${MODE}.md`, `Median / p95 in milliseconds, ${RUNS} runs per row, ${IDLE} ms of rest between edits (${MODE}).\n\n${table}\n`);
  console.log(table);
}

test("key press to painted frame", async ({ page }) => {
  const cells: Cell<KeySample>[] = [];
  // Keys arrive as fast as a quick typist and as slowly as a pause: 150 to 650 ms apart.
  let state = 11;
  const pause = (): number => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return 150 + (state % 500);
  };
  for (const strategy of KEY_STRATEGIES) {
    for (const shown of SHOWN) {
      await openScore(page, `/local?seed=perf&${strategy.query}&${shown.query}`);
      await page.waitForFunction(() => window.__studio!.player.state() !== "loading", null, { timeout: 60_000 });
      for (const bar of BARS) {
        await placeCursor(page, PART, bar, 0, 2);
        await page.waitForTimeout(500);
        const before = await page.evaluate(() => window.__studio!.keys.length);
        // 7, 8, 9 in turn: each is a fret of its own (78 is no fret), so every key is one edit.
        for (let i = 0; i < RUNS + 3; i++) {
          await page.keyboard.press(String(7 + (i % 3)));
          await page.waitForTimeout(pause());
        }
        await page.waitForTimeout(1700);
        const all = await page.evaluate((from) => window.__studio!.keys.slice(from), before);
        // The first three keys warm the path up and are left out.
        const samples = all.slice(3);
        expect(samples).toHaveLength(RUNS);
        cells.push({ strategy: strategy.id, shown: shown.id, bar: bar + 1, samples });
      }
      expect(await page.evaluate(() => window.__studio!.errors)).toEqual([]);
    }
  }
  const rows = cells.map((cell) => {
    const painted = cell.samples.filter((sample) => sample.painted !== null && sample.rendered !== null);
    const since = (key: "started" | "handled" | "rendered" | "painted" | "frame" | "nextFrame"): number[] => painted.map((sample) => (sample[key] as number) - sample.pressed);
    return `| ${cell.strategy} | ${cell.shown} | ${cell.bar} | ${stat(since("started"))} | ${stat(since("handled"))} | ${stat(since("rendered"))} | ${stat(since("painted"))} | ${stat(since("frame"))} | ${stat(since("nextFrame"))} | ${cell.samples.length - painted.length} |`;
  });
  const table = [
    "| strategy | shown | bar | handler starts | command done | rendered | bar painted | first frame | frame after | not painted |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ].join("\n");
  writeData(`s2-keys-${MODE}.json`, { environment: await environment(page), runs: RUNS, strategies: KEY_STRATEGIES, cells });
  writeText(`s2-keys-${MODE}.md`, `Milliseconds since the key press, median / p95, ${RUNS} keys per row (${MODE}).\n\n${table}\n`);
  console.log(table);
});
