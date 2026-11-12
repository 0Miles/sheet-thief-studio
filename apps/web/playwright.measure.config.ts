import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

// The M0 measurements (docs/spike-report.md): not tests of behaviour, so they are not part of
// `test:e2e`. Run with `pnpm --filter @studio/web measure`; HEADED=1 opens a real window.
// Results go to docs/spike/data, screenshots to docs/spike.
export default defineConfig({
  ...base,
  testDir: "e2e/measure",
  testIgnore: [],
  timeout: 30 * 60_000,
  reporter: "list",
  use: {
    ...base.use,
    headless: process.env.HEADED !== "1",
    viewport: { width: 1280, height: 900 },
    trace: "off",
  },
});
