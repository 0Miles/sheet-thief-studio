// Where the measurements write: screenshots in docs/measurements, numbers in
// docs/measurements/data, for the report of each milestone that measures again
// (docs/spec/testing.md, section 4). Those of M0 stay as they were, in docs/spike.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
export const SCREENSHOT_DIR = resolve(here, "../../../../docs/measurements");
export const DATA_DIR = resolve(SCREENSHOT_DIR, "data");

/** "headless" or "headed": measurements of both are kept side by side. */
export const MODE = process.env.HEADED === "1" ? "headed" : "headless";

export function writeData(name: string, data: unknown): string {
  mkdirSync(DATA_DIR, { recursive: true });
  const path = resolve(DATA_DIR, name);
  writeFileSync(path, `${JSON.stringify(data, null, 1)}\n`);
  return path;
}

export function writeText(name: string, text: string): string {
  mkdirSync(DATA_DIR, { recursive: true });
  const path = resolve(DATA_DIR, name);
  writeFileSync(path, text);
  return path;
}

export function screenshotPath(name: string): string {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  return resolve(SCREENSHOT_DIR, name);
}

/** What the measurement ran on, as the browser reports it. */
export async function environment(page: Page): Promise<Record<string, unknown>> {
  const browser = page.context().browser();
  return {
    mode: MODE,
    browser: `${browser?.browserType().name()} ${browser?.version()}`,
    ...(await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
      devicePixelRatio: window.devicePixelRatio,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    }))),
    measuredAt: new Date().toISOString(),
  };
}
