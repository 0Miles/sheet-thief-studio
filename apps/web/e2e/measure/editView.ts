// The measurements drive the edit view of a score the admin owns: through its keyboard, and
// through `window.__studioMeasure` (src/measureHook.ts) for what a member cannot do precisely
// enough by hand (an edit timed from the change, a cursor put on an exact beat).
import { expect, type Page } from "@playwright/test";

import { type DisplayOptions, displayKey } from "../../src/display";
import { ADMIN } from "../environment";
import { logInFromStart, playerSettled } from "../pages";
import type { SeededScore } from "./scores";

/** Log the page in as the admin, who owns every score the measurements make. */
export async function logInAsAdmin(page: Page): Promise<void> {
  await logInFromStart(page, ADMIN);
}

/**
 * Open the edit view of a score, showing only the part of index `only` (all of them when left
 * out), as the member's display options would; wait until it is drawn, in step with the server,
 * and its sound is ready. The page must already be on the app (logged in).
 */
export async function openEditView(page: Page, score: SeededScore, only?: number): Promise<void> {
  // The parts shown are the member's own option, stored in this browser (src/display.ts): stored
  // before the score opens, so that it is drawn with them from the start.
  const options: DisplayOptions = { hidden: only === undefined ? [] : score.partIds.filter((_, index) => index !== only), scale: 1 };
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [displayKey(score.id), JSON.stringify(options)] as const);
  await page.goto(`/scores/${score.id}`);
  // The score is drawn, the cursor placed, and the page in step with the server.
  await page.waitForFunction(() => window.__studioMeasure?.ready === true && window.__studioMeasure.synced(), null, { timeout: 60_000 });
  const shown = only === undefined ? score.partIds : [score.partIds[only]!];
  await expect(page.locator(`[data-parts="${shown.join(",")}"]`)).toBeAttached();
  // Playwright's WebKit for Windows has no Web Audio: the page has no player there (#129), and
  // makes no sound after a change either. Measured without, as the report says.
  await playerSettled(page);
}

/** Put the cursor in the append slot of an empty voice (-1) or on a beat of a bar of a part, in a voice ("0:0" unless told), and give the score the keyboard. */
export async function placeCursor(page: Page, part: number, bar: number, beat: number, line: number, voice = "0:0"): Promise<void> {
  const cursor = await page.evaluate(([p, b, at, l, v]) => window.__studioMeasure!.placeCursor(p as number, b as number, at as number, l as number, v as string), [part, bar, beat, line, voice] as const);
  expect(cursor).not.toBeNull();
  await page.locator("[data-scroller]").focus();
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

/** How many runs a measurement makes: 50 (S2) or 30 (S5), or fewer with MEASURE_RUNS for a quick check that the suite works. */
export function runs(full: number): number {
  const asked = Number(process.env.MEASURE_RUNS);
  return Number.isInteger(asked) && asked > 0 ? Math.min(asked, full) : full;
}
