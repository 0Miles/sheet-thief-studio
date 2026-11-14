// The measurements drive the edit view of a score the admin owns: through its keyboard, and
// through `window.__studioMeasure` (src/measureHook.ts) for what a member cannot do precisely
// enough by hand (an edit timed from the change, a cursor put on an exact beat).
import { expect, type Page } from "@playwright/test";

import { ADMIN } from "../environment";
import { logInFromStart, soundReady } from "../pages";

/** Log the page in as the admin, who owns every score the measurements make. */
export async function logInAsAdmin(page: Page): Promise<void> {
  await logInFromStart(page, ADMIN);
}

/**
 * Open the edit view of a score, showing only the part of index `only` (all of them when left
 * out), as the member's display options would; wait until it is drawn, in step with the server,
 * and its sound is ready.
 */
export async function openEditView(page: Page, scoreId: string, only?: number): Promise<void> {
  await page.goto(`/scores/${scoreId}`);
  await page.waitForFunction(() => window.__studioMeasure?.ready === true && window.__studioMeasure.synced(), null, { timeout: 60_000 });
  // The parts shown are the member's own option, stored in this browser (src/display.ts): stored
  // here before the score opens again, so that it is drawn with them from the start.
  const json = await page.evaluate(() => window.__studioMeasure!.json());
  const hidden = only === undefined ? [] : json.parts.filter((_, index) => index !== only).map((part) => part.id);
  const stored = await page.evaluate(([id, hide]) => {
    const key = `studio.display.${id}`;
    const before = localStorage.getItem(key);
    localStorage.setItem(key, JSON.stringify({ hidden: hide, scale: 1 }));
    return before;
  }, [scoreId, hidden] as const);
  if (stored !== JSON.stringify({ hidden, scale: 1 })) {
    await page.reload();
    await page.waitForFunction(() => window.__studioMeasure?.ready === true && window.__studioMeasure.synced(), null, { timeout: 60_000 });
  }
  const shown = (only === undefined ? json.parts : [json.parts[only]!]).map((part) => part.id).join(",");
  await expect(page.locator(`[data-parts="${shown}"]`)).toBeAttached();
  await soundReady(page);
}

/** Put the cursor in the append slot of an empty voice (-1) or on a beat of a bar of a part, and give the score the keyboard. */
export async function placeCursor(page: Page, part: number, bar: number, beat: number, line: number): Promise<void> {
  const cursor = await page.evaluate(([p, b, at, l]) => window.__studioMeasure!.placeCursor(p!, b!, at!, l!), [part, bar, beat, line]);
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
