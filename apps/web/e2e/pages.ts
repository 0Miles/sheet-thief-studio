// Helpers for the end-to-end tests that go through the real pages: logging in, creating a score,
// opening it and reading it, and collecting the errors a page throws or logs.
import { spawnSync } from "node:child_process";

import { type Browser, type BrowserContextOptions, expect, type Page } from "@playwright/test";
import type { Role } from "@studio/contracts";
import type { BeatJSON, Cursor, PartKind, ScoreJSON } from "@studio/score-model";

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
 * and the parts it has after the first one every new score has (「吉他 1」); or, for the measure
 * suite, its whole content as a Yjs update in base64 (`state`).
 */
export interface ScoreFixture {
  title: string;
  owner: string;
  members?: { username: string; role: Exclude<Role, "owner"> }[];
  bars?: number;
  parts?: { name: string; kind: PartKind }[];
  state?: string;
}

/**
 * A score with its members, written straight into the tests' database by the server's own
 * script (apps/server/tests/scoreE2e.ts): data a test needs before it starts, set up without
 * going through the pages (adding members has its own test, members.spec.ts). Returns its id.
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

/** An account as the server's script makes it (apps/server/tests/accountE2e.ts). */
export interface AccountFixture {
  username: string;
  displayName: string;
  password: string;
  isAdmin: boolean;
  mustChangePassword: boolean;
}

/**
 * An account of the test's own, written into the tests' database by the server's script: one the
 * test uses up (it changes its temporary password), so each run, retry and browser makes another.
 */
export function seedAccount(fixture: AccountFixture): void {
  const made = spawnSync("pnpm", ["--silent", "--filter", "@studio/server", "account:e2e"], {
    input: JSON.stringify(fixture),
    env: { ...process.env, ...SERVER_ENV },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (made.status !== 0) throw new Error(`Could not make the account: ${made.stderr}`);
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

/** The beats of the first voice of a bar of a part, both by index. */
export function beatsIn(score: ScoreJSON, part: number, bar: number): BeatJSON[] {
  const barId = score.bars[bar]!.id;
  return score.parts[part]!.content[barId]?.["0:0"] ?? [];
}

export function cursorOf(page: Page): Promise<Cursor | null> {
  return page.evaluate(() => window.__studioTest!.cursor());
}

/**
 * Type one beat per fret from the append slot, as someone entering notes does: the digit makes
 * the beat, → goes on to the append slot after it. The first beat is made a sixteenth and the
 * next ones take the length of the one before, so that two members typing six beats each in one
 * bar of 4/4 never fill it, and → never leaves the bar.
 */
export async function typeBeats(page: Page, frets: number[]): Promise<void> {
  for (const [index, fret] of frets.entries()) {
    await page.keyboard.press(String(fret));
    if (index === 0) {
      await page.keyboard.press("+");
      await page.keyboard.press("+");
    }
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(20);
  }
}
