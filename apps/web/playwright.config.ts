import { defineConfig, devices } from "@playwright/test";

import { SERVER_ENV } from "./e2e/environment";

/**
 * The server, and the web app built with `env`: VITE_E2E=1 here, for `window.__studioTest`
 * (src/testHook.ts); VITE_MEASURE=1 in playwright.measure.config.ts.
 */
export function webServers(env: Record<string, string>) {
  return [
    {
      command: "pnpm --filter @studio/server start",
      env: SERVER_ENV,
      url: "http://localhost:8031/healthz",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: "pnpm build && pnpm preview",
      env,
      url: "http://localhost:5183",
      // Never an older preview: it may be a build with other flags, or of other sources.
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ];
}

// End-to-end tests run against the real server and the built web app, on the ports the
// project uses in development (8031 and 5183), and against the Postgres and Redis of
// compose.dev.yaml in databases of their own (e2e/environment.ts). Both ports must be free: a dev
// server on 8031 would use the development database, and a page server on 5183 may be a build
// without VITE_E2E. Playwright refuses to reuse either.
export default defineConfig({
  testDir: "e2e",
  testIgnore: "**/measure/**",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: "http://localhost:5183",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: webServers({ VITE_E2E: "1" }),
});
