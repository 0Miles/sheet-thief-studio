import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

import { RECOGNIZER_URL, SERVER_ENV } from "./e2e/environment";

/**
 * The server, and the web app built with `env`: VITE_E2E=1 here, for `window.__studioTest`
 * (src/testHook.ts); VITE_MEASURE=1 in playwright.measure.config.ts.
 */
export function webServers(env: Record<string, string>) {
  return [
    // The stand-in recognizer the server calls (e2e/environment.ts).
    {
      command: "pnpm --filter @studio/server recognizer:e2e",
      env: { PORT: new URL(RECOGNIZER_URL).port },
      url: `${RECOGNIZER_URL}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
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

/** Where the second server serves the build itself, as in production (the `served` project). */
const SERVED_ORIGIN = "http://localhost:8032";

/**
 * The server once more, on a port of its own, serving the build the preview has just made: the
 * Origin a server accepts is the one its pages come from, so one server cannot stand behind both.
 */
const servedPages = {
  command: "pnpm --filter @studio/server start",
  env: { ...SERVER_ENV, PORT: "8032", PUBLIC_ORIGIN: SERVED_ORIGIN, WEB_ROOT: fileURLToPath(new URL("dist", import.meta.url)) },
  url: `${SERVED_ORIGIN}/healthz`,
  reuseExistingServer: false,
  timeout: 60_000,
};

/** Where a third server serves the build with the development cookie, for WebKit (the `webkit` project). */
export const INSECURE_ORIGIN = "http://localhost:8033";

/**
 * The server serving the build once more, with the cookie without the `__Host-` prefix and
 * `Secure` (INSECURE_COOKIES=1, docs/spec/security.md, section 1): WebKit refuses a `__Host-`
 * cookie over http, so its smoke tests log in here. Chromium and Firefox keep the `__Host-` one.
 */
export const insecurePages = {
  ...servedPages,
  env: { ...servedPages.env, PORT: "8033", PUBLIC_ORIGIN: INSECURE_ORIGIN, INSECURE_COOKIES: "1" },
  url: `${INSECURE_ORIGIN}/healthz`,
};

/** Where the stand-in karyl-chan bot serves the plugin's pages (the `plugin` project). */
export const BOT_ORIGIN = "http://localhost:8036";
/** Where the server serves as the bot's plugin. */
const PLUGIN_PORT = 8035;
const PLUGIN_SETUP_SECRET = "e2e-setup-secret";

/**
 * The stand-in karyl-chan bot (apps/server/tests/botE2e.ts), and the server as its plugin on a
 * port of its own, serving the build the preview has made: the bot proxies its pages under
 * `/plugin/sheet-thief-studio/`, without cookies (docs/spec/karyl-login.md).
 */
const pluginPages = [
  {
    command: "pnpm --filter @studio/server bot:e2e",
    env: { PORT: new URL(BOT_ORIGIN).port, SETUP_SECRET: PLUGIN_SETUP_SECRET },
    url: `${BOT_ORIGIN}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
  {
    command: "pnpm --filter @studio/server start",
    env: {
      ...servedPages.env,
      PORT: String(PLUGIN_PORT),
      PUBLIC_ORIGIN: BOT_ORIGIN,
      KARYL_PLUGIN_SETUP_SECRET: PLUGIN_SETUP_SECRET,
      BOT_URL: `http://127.0.0.1:${new URL(BOT_ORIGIN).port}`,
      PLUGIN_URL: `http://127.0.0.1:${PLUGIN_PORT}`,
    },
    url: `http://localhost:${PLUGIN_PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
];

// End-to-end tests run against the real server and the built web app, on the ports the
// project uses in development (8031 and 5183), and against the Postgres and Redis of
// compose.dev.yaml in databases of their own (e2e/environment.ts). Both ports must be free: a dev
// server on 8031 would use the development database, and a page server on 5183 may be a build
// without VITE_E2E. Playwright refuses to reuse either. One spec, served.spec.ts, gets its pages
// from a second server instead (port 8032), with the Content Security Policy on them; WebKit's
// smoke tests get theirs from a third (port 8033), with the development cookie.
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
  projects: [
    { name: "chromium", testIgnore: ["**/measure/**", "**/served.spec.ts", "**/plugin.spec.ts", "**/smoke/**"], use: { ...devices["Desktop Chrome"] } },
    { name: "served", testMatch: "**/served.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: SERVED_ORIGIN } },
    // Behind the stand-in karyl-chan bot, under its /plugin/<key>/ (plugin.spec.ts).
    { name: "plugin", testMatch: "**/plugin.spec.ts", use: { ...devices["Desktop Chrome"], baseURL: BOT_ORIGIN } },
    // The whole suite runs in Chromium; the other browsers run smoke tests, and the clipboard check
    // of #52, which is to pass in all three (docs/spec/testing.md, sections 3 and 5). Firefox also
    // runs what drawFailure.spec.ts does not tag for Chromium alone: two engines whose fonts both
    // failed, the failed font face of the one left on the page under the name of the other's (#198).
    {
      name: "firefox",
      testMatch: ["**/smoke/typing.spec.ts", "**/clipboard.spec.ts", "**/drawFailure.spec.ts"],
      grepInvert: /@chromium-only/,
      use: { ...devices["Desktop Firefox"] },
    },
    { name: "webkit", testMatch: ["**/smoke/*.spec.ts", "**/clipboard.spec.ts"], use: { ...devices["Desktop Safari"], baseURL: INSECURE_ORIGIN } },
  ],
  webServer: [...webServers({ VITE_E2E: "1" }), servedPages, insecurePages, ...pluginPages],
});
