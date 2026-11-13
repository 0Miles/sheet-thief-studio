import { defineConfig, devices } from "@playwright/test";

import { SERVER_ENV } from "./e2e/environment";

// End-to-end tests run against the real server and the built web app, on the ports the
// project uses in development (8031 and 5183), and against the Postgres and Redis of
// compose.dev.yaml in databases of their own (e2e/environment.ts). A dev server already on 8031
// would use the development database: stop it first, Playwright refuses to reuse it.
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
  webServer: [
    {
      command: "pnpm --filter @studio/server start",
      env: SERVER_ENV,
      url: "http://localhost:8031/healthz",
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      // The end-to-end build: it has `window.__studioTest` (src/testHook.ts); no other build does.
      command: "pnpm build && pnpm preview",
      env: { VITE_E2E: "1" },
      url: "http://localhost:5183",
      // Never an older preview: it may be a build without VITE_E2E, or of other sources.
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
