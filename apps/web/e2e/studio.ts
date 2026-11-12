// Helpers shared by the end-to-end tests and the M0 measurements: they drive the spike page
// through its keyboard and read it through `window.__studio` (src/spike/hook.ts).
import { expect, type Page } from "@playwright/test";
import type { BeatJSON, ScoreJSON } from "@studio/score-model";

/** Open a spike page and wait until its score is drawn. */
export async function openScore(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(() => window.__studio?.ready === true, null, { timeout: 60_000 });
}

export function scoreOf(page: Page): Promise<ScoreJSON> {
  return page.evaluate(() => window.__studio!.json());
}

/** The beats of the first voice of a bar of a part, both by index. */
export function beatsIn(score: ScoreJSON, part: number, bar: number): BeatJSON[] {
  const barId = score.bars[bar]!.id;
  return score.parts[part]!.content[barId]?.["0:0"] ?? [];
}

/** Put the cursor before the first beat (-1) or on a beat of a bar of a part, and give the page the keyboard. */
export async function placeCursor(page: Page, part: number, bar: number, beat: number, line: number): Promise<void> {
  const cursor = await page.evaluate(([p, b, at, l]) => window.__studio!.placeCursor(p!, b!, at!, l!), [part, bar, beat, line]);
  expect(cursor).not.toBeNull();
  await page.locator(".scroller").focus();
}

/** Wait until every page has sent its changes and all hold the same score; returns that score. */
export async function settled(pages: Page[]): Promise<ScoreJSON> {
  await expect
    .poll(
      async () => {
        const synced = await Promise.all(pages.map((page) => page.evaluate(() => window.__studio!.synced())));
        const scores = await Promise.all(pages.map((page) => page.evaluate(() => JSON.stringify(window.__studio!.json()))));
        return synced.every(Boolean) && scores.every((score) => score === scores[0]);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  return scoreOf(pages[0]!);
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The 95th percentile by the nearest-rank method: with 50 values, the 48th smallest. */
export function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
}
