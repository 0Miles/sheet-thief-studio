// Helpers for the end-to-end tests that go through the real pages: logging in, creating a score,
// and collecting the errors a page throws or logs.
import { spawnSync } from "node:child_process";

import { type Browser, type BrowserContextOptions, expect, type Page } from "@playwright/test";
import type { Role } from "@studio/contracts";

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

/** What `seedScore` makes: account names, and how many bars the score starts with (8 when left out). */
export interface ScoreFixture {
  title: string;
  owner: string;
  members?: { username: string; role: Exclude<Role, "owner"> }[];
  bars?: number;
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
