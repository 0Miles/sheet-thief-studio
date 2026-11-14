// Helpers for the end-to-end tests that go through the real pages: logging in, creating a score,
// opening it and reading it, and collecting the errors a page throws or logs.
import { spawnSync } from "node:child_process";

import { type Browser, type BrowserContextOptions, expect, type Page } from "@playwright/test";
import type { Role } from "@studio/contracts";
import type { Cursor, PartKind, ScoreJSON } from "@studio/score-model";

import { strings } from "../src/strings";
import { SERVER_ENV } from "./environment";

/** An answer the test expects the server to refuse: the browser logs it as an error, which it is not here. */
export interface Refusal {
  status: number;
  /** The end of the URL of the request. */
  path: string;
}

/**
 * Every error the page throws or logs, collected for the test to assert there are none. The
 * browser logs each refused call too: those in `refused` (by default the 401 of GET /api/me, how
 * the page learns that nobody is logged in) are what the test expects, not errors.
 */
export function pageErrors(page: Page, refused: Refusal[] = [{ status: 401, path: "/api/me" }]): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location().url;
    const expected = refused.some(({ status, path }) => message.text().includes(String(status)) && url.endsWith(path));
    if (!expected) errors.push(message.text());
  });
  return errors;
}

export async function logIn(page: Page, username: string, password: string): Promise<void> {
  await page.getByLabel(strings.login.username).fill(username);
  await page.getByLabel(strings.login.password).fill(password);
  await page.getByRole("button", { name: strings.login.submit }).click();
}

/** Log in as this account from /login, and land on `/`. */
export async function logInFromStart(page: Page, account: { username: string; password: string }): Promise<void> {
  await page.goto("/login");
  await logIn(page, account.username, account.password);
  await expect(page).toHaveURL("/");
}

/** A page of its own browser context, logged in as this account, on `/`. */
export async function loggedIn(browser: Browser, account: { username: string; password: string }, options: BrowserContextOptions = {}): Promise<Page> {
  const page = await (await browser.newContext(options)).newPage();
  await logInFromStart(page, account);
  return page;
}

/** Create a score through the API as the account logged in on the page; returns its id. */
export async function createScore(page: Page, title: string): Promise<string> {
  const origin = new URL(page.url()).origin;
  const response = await page.request.post("/api/scores", { data: { title }, headers: { origin } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/**
 * What `seedScore` makes: account names, how many bars the score starts with (8 when left out),
 * and the parts it has after the first one every new score has (「吉他 1」).
 */
export interface ScoreFixture {
  title: string;
  owner: string;
  members?: { username: string; role: Exclude<Role, "owner"> }[];
  bars?: number;
  parts?: { name: string; kind: PartKind }[];
}

/**
 * A score with its members, written straight into the tests' database by the server's own
 * script (apps/server/tests/scoreE2e.ts): data a test needs before it starts, for which there
 * is no page yet (adding members comes with #13). Returns its id.
 */
export function seedScore(fixture: ScoreFixture): string {
  const made = spawnSync("pnpm", ["--silent", "--filter", "@studio/server", "score:e2e"], {
    input: JSON.stringify(fixture),
    env: { ...process.env, ...SERVER_ENV },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (made.status !== 0) throw new Error(`Could not make the score: ${made.stderr}`);
  return (JSON.parse(made.stdout) as { id: string }).id;
}

/** Every change typed here has reached the server. */
export async function synced(page: Page): Promise<void> {
  await expect(page.locator('[data-sync="synced"]')).toBeVisible();
}

/** Wait until the score is drawn and in step with the server; the score then has the keyboard. */
export async function drawn(page: Page): Promise<void> {
  await expect(page.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await synced(page);
}

export async function openScore(page: Page, id: string): Promise<void> {
  await page.goto(`/scores/${id}`);
  await drawn(page);
}

/** Wait until the score's sound is ready: the player is there, paused. */
export async function soundReady(page: Page): Promise<void> {
  await expect(page.locator('[data-player="paused"]')).toBeVisible({ timeout: 30_000 });
}

export function scoreOf(page: Page): Promise<ScoreJSON> {
  return page.evaluate(() => window.__studioTest!.scoreJson()!);
}

export function cursorOf(page: Page): Promise<Cursor | null> {
  return page.evaluate(() => window.__studioTest!.cursor());
}
