import { defineConfig, devices } from "@playwright/test";

import base, { INSECURE_ORIGIN, insecurePages, webServers } from "./playwright.config";

// The measurements (docs/spec/testing.md, section 4): not tests of behaviour, so they are not part
// of `test:e2e`. Run with `pnpm --filter @studio/web measure`; HEADED=1 opens a real window, and
// MEASURE_RUNS=3 makes every measurement short, to check that the suite works. They run in the
// edit view of scores written into the end-to-end database, against the same server; results go
// to docs/measurements/data, screenshots to docs/measurements. The viewport is 1280 × 720 at a
// device pixel ratio of 1 in every browser.
//
// One project per browser, chosen with `--project`: `chromium` runs every measurement; `firefox`
// and `webkit` run S2 (latency.spec.ts), the one measured in every browser. WebKit logs in to the
// server serving the build with the development cookie (port 8033), as its smoke tests do: it
// refuses a `__Host-` cookie over http.
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
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", testMatch: "**/latency.spec.ts", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", testMatch: "**/latency.spec.ts", use: { ...devices["Desktop Safari"], deviceScaleFactor: 1, baseURL: INSECURE_ORIGIN } },
  ],
  // The measurement build: it has `window.__studioMeasure` (src/measureHook.ts) and no other.
  webServer: [...webServers({ VITE_MEASURE: "1" }), insecurePages],
});
