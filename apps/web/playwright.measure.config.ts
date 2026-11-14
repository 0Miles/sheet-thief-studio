import { defineConfig } from "@playwright/test";

import base, { webServers } from "./playwright.config";

// The measurements (docs/spec/testing.md, section 4): not tests of behaviour, so they are not part
// of `test:e2e`. Run with `pnpm --filter @studio/web measure`; HEADED=1 opens a real window, and
// MEASURE_RUNS=3 makes every measurement short, to check that the suite works. They run in the
// edit view of scores written into the end-to-end database, against the same server; results go
// to docs/measurements/data, screenshots to docs/measurements. The viewport is the project's
// (Desktop Chrome, 1280 × 720).
export default defineConfig({
  ...base,
  testDir: "e2e/measure",
  testIgnore: [],
  timeout: 30 * 60_000,
  reporter: "list",
  use: {
    ...base.use,
    headless: process.env.HEADED !== "1",
    trace: "off",
  },
  // The measurement build: it has `window.__studioMeasure` (src/measureHook.ts) and no other.
  webServer: webServers({ VITE_MEASURE: "1" }),
});
