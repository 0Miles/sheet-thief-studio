import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against the real server and the built web app, on the ports the
// project uses in development (8031 and 5183): stop a dev server before running them in CI.
export default defineConfig({
  testDir: "e2e",
  testIgnore: "**/measure/**",
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
      url: "http://localhost:8031/healthz",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "pnpm build && pnpm preview",
      url: "http://localhost:5183",
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
