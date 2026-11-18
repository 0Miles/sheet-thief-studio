// The studio as a karyl-chan plugin, behind the stand-in bot (apps/server/tests/botE2e.ts) that
// serves it under /plugin/sheet-thief-studio/ without cookies, as the real bot's proxy does
// (docs/spec/karyl-login.md). The only spec of the `plugin` project (playwright.config.ts).
import { randomBytes } from "node:crypto";

import type { APIRequestContext, Page } from "@playwright/test";

import { strings } from "../src/strings";
import { bindDiscord, drawn, pageErrors, seedAccount, soundReady, synced, typeBeats } from "./pages";
import { expect, test } from "./test";

const BASE = "/plugin/sheet-thief-studio/";
const karyl = strings.login.karyl;

/** A Discord id of this run's own: 18 digits. */
const newDiscordId = () => `8${BigInt(`0x${randomBytes(7).toString("hex")}`).toString().padStart(17, "0").slice(-17)}`;

/** The link the bot's answer to `/studio` of this Discord user holds, once the plugin has registered. */
async function studioLink(request: APIRequestContext, userId: string): Promise<string> {
  await expect.poll(async () => (await request.get("/test/registered")).status(), { timeout: 30_000 }).toBe(200);
  const answer = await request.post("/test/studio", { data: { userId } });
  expect(answer.status()).toBe(200);
  return ((await answer.json()) as { link: string }).link;
}

/** The Bearer token the page keeps for the plugin's base path. */
const keptSession = (page: Page) => page.evaluate((base) => localStorage.getItem(`studio:session:${base}`), BASE);

/** A member of this run's own, with a Discord id bound by the server's CLI. */
function boundMember() {
  const member = { username: `e2e-plugin-${randomBytes(4).toString("hex")}`, displayName: "從 Discord 來的成員", password: "e2e plugin password", isAdmin: false, mustChangePassword: false };
  seedAccount(member);
  const discordId = newDiscordId();
  bindDiscord(member.username, discordId);
  return { ...member, discordId };
}

test("a member logs in from the link of /studio under the bot's base path; a score opens drawn, with its sound, and takes what is typed", async ({ page, request }) => {
  const member = boundMember();
  const errors = pageErrors(page);
  const link = await studioLink(request, member.discordId);
  expect(new URL(link).pathname).toBe(`${BASE}auth/karyl`);

  await page.goto(link);

  // Home, under the base path, the session out of the address and kept by the page.
  await expect(page).toHaveURL(BASE);
  await expect(page.getByRole("heading", { name: strings.home.title })).toBeVisible();
  await expect(page.getByRole("link", { name: member.displayName })).toBeVisible();
  const session = await keptSession(page);
  expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const created = await page.request.post(`${BASE}api/scores`, { data: { title: "從 Discord 開的譜" }, headers: { origin: new URL(page.url()).origin, authorization: `Bearer ${session}` } });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  await page.goto(`${BASE}scores/${id}`);
  // Through the bot's proxy: the page's scripts and alphaTab's workers, font and soundfont, and /collab.
  await drawn(page);
  await soundReady(page);
  await typeBeats(page, [5, 7]);
  await synced(page);

  // Still logged in on the next load.
  await page.reload();
  await drawn(page);

  await page.getByRole("button", { name: strings.header.logout }).click();
  await expect(page).toHaveURL(`${BASE}login`);
  await expect(page.getByText(karyl.instructions)).toBeVisible();
  expect(await keptSession(page)).toBeNull();
  expect(errors).toEqual([]);
});

test("a link of an unbound Discord id, and a link used already: /login says why, and asks for no password", async ({ page, browser, request }) => {
  const unbound = newDiscordId();
  const errors = pageErrors(page);

  await page.goto(await studioLink(request, unbound));

  await expect(page).toHaveURL(`${BASE}login`);
  await expect(page.getByRole("alert")).toHaveText(karyl.unbound(unbound));
  await expect(page.getByText(karyl.instructions)).toBeVisible();
  await expect(page.getByLabel(strings.login.password)).toHaveCount(0);
  expect(await keptSession(page)).toBeNull();

  const member = boundMember();
  const link = await studioLink(request, member.discordId);
  await page.goto(link);
  await expect(page).toHaveURL(BASE);
  const another = await (await browser.newContext()).newPage();
  await another.goto(link);
  await expect(another).toHaveURL(`${BASE}login`);
  await expect(another.getByRole("alert")).toHaveText(karyl.invalid);
  expect(errors).toEqual([]);
});
