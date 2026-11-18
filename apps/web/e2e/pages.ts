// Helpers for the end-to-end tests that go through the real pages: logging in, creating a score,
// opening it and reading it, and collecting the errors a page throws or logs.
import { spawnSync } from "node:child_process";

import { type Browser, type BrowserContextOptions, type ConsoleMessage, expect, type Page } from "@playwright/test";
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
    if (expected) return;
    // Firefox gives an object logged as `JSHandle@object`: the entry is written out once its
    // arguments have been read from the page, with where it was logged from.
    const index = errors.push(message.text()) - 1;
    void describe(message).then((described) => (errors[index] = described));
  });
  return errors;
}

/** A console message as its arguments read in the page, and the script and line that logged it. */
async function describe(message: ConsoleMessage): Promise<string> {
  const { url, lineNumber, columnNumber } = message.location();
  const where = url ? ` (at ${url}:${lineNumber}:${columnNumber})` : "";
  try {
    const args = await Promise.all(
      message.args().map((arg) =>
        arg.evaluate((value) => {
          if (value instanceof Error) return `${value.name}: ${value.message}`;
          if (typeof value !== "object" || value === null) return String(value);
          try {
            return JSON.stringify(value) ?? String(value);
          } catch {
            return Object.prototype.toString.call(value);
          }
        }),
      ),
    );
    return `${args.join(" ")}${where}`;
  } catch {
    // The page is gone: what Playwright gave is all there is.
    return `${message.text()}${where}`;
  }
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
  // Until the page has its lists: a test that goes on to another address before then has Firefox
  // abort the page's requests for them (NS_BINDING_ABORTED), and the page reports a list it could
  // not get as an error of the page (HomeView.vue), which the test's error check then hears.
  await expect(page.getByRole("heading", { name: strings.home.title })).toBeVisible();
  await expect(page.getByText(strings.loading)).toBeHidden();
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
  return (JSON.parse(runServerScript("score:e2e", fixture, "the score")) as { id: string }).id;
}

/** Run one of the server's e2e scripts on the tests' database, the fixture as its input; returns what it printed. */
function runServerScript(script: string, fixture: object, made: string): string {
  const run = spawnSync("pnpm", ["--silent", "--filter", "@studio/server", script], {
    input: JSON.stringify(fixture),
    env: { ...process.env, ...SERVER_ENV },
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (run.status !== 0) throw new Error(`Could not make ${made}: ${run.stderr}`);
  return run.stdout;
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
  runServerScript("account:e2e", fixture, "the account");
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

/**
 * Wait until the player is where it stays until asked to play, as the page tells it: paused once
 * its sound is ready, or unavailable in a browser it cannot play in (docs/spec/playback.md, 4.1;
 * Playwright's WebKit for Windows has no Web Audio, #129). Which of the two, the page decides.
 */
export async function playerSettled(page: Page): Promise<"paused" | "unavailable"> {
  const player = page.locator('[data-player="paused"], [data-player="unavailable"]');
  await expect(player).toBeVisible({ timeout: 30_000 });
  return (await player.getAttribute("data-player")) as "paused" | "unavailable";
}

/** Open the score and wait until it is drawn, in step with the server, and its sound is ready. */
export async function openToPlay(page: Page, id: string): Promise<void> {
  await openScore(page, id);
  await soundReady(page);
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

/**
 * From now on, write down every bar the toolbar shows as playing, in the order it shows them
 * (each once, as it changes); `barsShown` reads them back.
 */
export async function recordBarsShown(page: Page): Promise<void> {
  await page.evaluate(() => {
    const shown: number[] = [];
    (window as unknown as { barsShown: number[] }).barsShown = shown;
    const toolbar = document.querySelector("[data-player]")!;
    new MutationObserver(() => {
      const bar = document.querySelector("[data-playing-bar]")?.getAttribute("data-bar");
      if (bar != null && shown.at(-1) !== Number(bar)) shown.push(Number(bar));
    }).observe(toolbar, { subtree: true, childList: true, attributes: true, characterData: true });
  });
}

export function barsShown(page: Page): Promise<number[]> {
  return page.evaluate(() => (window as unknown as { barsShown: number[] }).barsShown);
}

/** Each bar shown is the one after the bar shown before it: playback went on, it never jumped. */
export function oneAfterAnother(bars: number[]): boolean {
  return bars.every((bar, index) => index === 0 || bar === bars[index - 1]! + 1);
}

/** Wait until the toolbar has shown this bar playing (a 4/4 bar lasts 2 seconds at 120). */
export async function untilShown(page: Page, bar: number): Promise<void> {
  await expect.poll(() => barsShown(page), { timeout: 15_000 }).toContain(bar);
}
