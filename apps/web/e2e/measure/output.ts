// Where the measurements write: screenshots in docs/measurements, numbers in
// docs/measurements/data, for the report of each milestone that measures again
// (docs/spec/testing.md, section 4). Those of M0 stay as they were, in docs/spike.
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, cpus, release, totalmem, type } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Page } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
export const SCREENSHOT_DIR = resolve(here, "../../../../docs/measurements");
export const DATA_DIR = resolve(SCREENSHOT_DIR, "data");

/**
 * The milestone measured again, the first part of the name of S2's files: those of every
 * milestone are kept side by side (m1b-s2-keys-firefox-headless.json, m2-…), for its report to
 * compare with the one before. Change it in the ticket that measures again.
 */
export const MILESTONE = "m2";

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

/** The browser of the page: "chromium", "firefox" or "webkit". */
export function browserOf(page: Page): string {
  return page.context().browser()?.browserType().name() ?? "unknown";
}

/** What the measurement ran on, as the browser and Node report it. */
export async function environment(page: Page): Promise<Record<string, unknown>> {
  const browser = page.context().browser();
  return {
    mode: MODE,
    browser: `${browser?.browserType().name()} ${browser?.version()}`,
    node: process.version,
    os: `${type()} ${release()} ${arch()}`,
    cpu: cpus()[0]?.model.trim(),
    logicalCpus: cpus().length,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    ...(await page.evaluate(() => {
      // The smallest step performance.now() takes: browsers coarsen it, Firefox to 1 ms or so.
      let step = Infinity;
      let steps = 0;
      let last = performance.now();
      for (let i = 0; i < 5_000_000 && steps < 50; i++) {
        const now = performance.now();
        if (now > last) {
          step = Math.min(step, now - last);
          steps += 1;
        }
        last = now;
      }
      return {
        userAgent: navigator.userAgent,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
        devicePixelRatio: window.devicePixelRatio,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        webAudio: typeof AudioContext !== "undefined",
        timerStepMs: step,
      };
    })),
    measuredAt: new Date().toISOString(),
  };
}
