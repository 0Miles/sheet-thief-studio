// Logging in from a link of the karyl-chan bot, and the Bearer session the plugin's pages show
// (docs/spec/karyl-login.md, sections 2, 4 and 5).
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";

import { createAccount, setDisabled } from "../src/accounts";
import { buildApp } from "../src/app";
import { Identity } from "../src/db/models";
import { withoutLinkTokens } from "../src/links";
import { DISCORD_ID, pluginSession, registeredPlugin, signingAuthority } from "./karyl";
import { COOKIE, freshDatabase, freshRedis, listen, openScore, ORIGIN, sessionOf, testConfig } from "./support";

const PASSWORD = "a password long enough";
const bot = signingAuthority();

let sequelize: Sequelize;
let redis: Redis;
let app: FastifyInstance;
let accounts = 0;

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
});

beforeEach(async () => {
  await redis.flushdb();
  app = buildApp({ config: testConfig(), redis, logger: false, karyl: registeredPlugin(bot.publicPem) });
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await redis.quit();
  await sequelize.close();
});

/** A new account bound to a Discord id of its own; `mustChangePassword` as an admin's new account has it. */
async function boundAccount(): Promise<{ id: string; username: string; discordId: string }> {
  accounts += 1;
  const username = `karyl-${accounts}`;
  const discordId = `1${String(accounts).padStart(17, "0")}`;
  const { id } = await createAccount({ username, displayName: "成員", password: PASSWORD, isAdmin: false, mustChangePassword: true });
  await Identity.create({ accountId: id, provider: "karyl-chan", subject: discordId });
  return { id, username, discordId };
}

/** Open the link the bot would hand out, as the bot's proxy forwards it (the base path stripped). */
const open = (token: string | null, remoteAddress?: string) =>
  app.inject({ method: "GET", url: token === null ? "/auth/karyl" : `/auth/karyl?token=${encodeURIComponent(token)}`, ...(remoteAddress === undefined ? {} : { remoteAddress }) });

/** The session id the answer hands the page in the fragment of where it sends it. */
function signedIn(answer: { statusCode: number; headers: Record<string, unknown> }): string {
  expect(answer.statusCode).toBe(302);
  const match = /^\.\.\/#session=([A-Za-z0-9_-]+)$/.exec(String(answer.headers.location));
  if (match === null) throw new Error(`not signed in: ${String(answer.headers.location)}`);
  return match[1]!;
}

/** Where a link that logged nobody in sends the browser: /login, with the reason in the fragment. */
const refused = (reason: string) => ({ status: 302, location: `../login#karyl=${encodeURIComponent(reason)}` });
const outcome = (answer: { statusCode: number; headers: Record<string, unknown> }) => ({ status: answer.statusCode, location: answer.headers.location });

const bearer = (sessionId: string) => ({ authorization: `Bearer ${sessionId}` });

/** Every session Redis holds. */
const storedSessions = () => redis.keys("session:*");

test("a link of a bound account logs in: a session with no new password to choose, shown as a Bearer token", async () => {
  const account = await boundAccount();

  const answer = await open(pluginSession(bot.privateKey, account.discordId));

  const sessionId = signedIn(answer);
  expect(answer.headers["cache-control"]).toBe("no-store");
  expect(answer.headers["set-cookie"]).toBeUndefined();
  const me = await app.inject({ method: "GET", url: "/api/me", headers: bearer(sessionId) });
  expect([me.statusCode, me.json()]).toEqual([200, expect.objectContaining({ username: account.username, mustChangePassword: false })]);
  // A Bearer session gets no cookie: the page keeps the token.
  expect(me.headers["set-cookie"]).toBeUndefined();
  expect(JSON.parse((await redis.get(`session:${sessionId}`))!)).toMatchObject({ accountId: account.id, via: "karyl-chan" });
});

test("a link opens once: the same token again logs nobody in", async () => {
  const account = await boundAccount();
  const token = pluginSession(bot.privateKey, account.discordId);

  signedIn(await open(token));

  expect(outcome(await open(token))).toEqual(refused("invalid"));
  expect(await storedSessions()).toHaveLength(1);
  // Remembered until the token would have expired anyway, with the bot's clock a little ahead.
  const [used] = await redis.keys("karyl-login-used:*");
  expect(await redis.ttl(used!)).toBeGreaterThan(120);
  expect(await redis.ttl(used!)).toBeLessThanOrEqual(125);
});

test("a token that is not one logs nobody in: forged, expired, of another purpose or algorithm, cut short, or none", async () => {
  const account = await boundAccount();
  const other = signingAuthority();
  const good = pluginSession(bot.privateKey, account.discordId);
  const tokens: Array<[string, string | null]> = [
    ["signed by another key", pluginSession(other.privateKey, account.discordId)],
    ["expired", pluginSession(bot.privateKey, account.discordId, { ttlSeconds: -1 })],
    ["another purpose", pluginSession(bot.privateKey, account.discordId, { claims: { purpose: "manage-access" } })],
    ["another algorithm", pluginSession(bot.privateKey, account.discordId, { header: { alg: "HS256" } })],
    ["the signature cut off", good.slice(0, good.lastIndexOf(".") + 1)],
    ["not a token", "not-a-token"],
    ["none", null],
  ];
  for (const [what, token] of tokens) expect([what, outcome(await open(token))]).toEqual([what, refused("invalid")]);
  expect(await storedSessions()).toEqual([]);
});

test("before the plugin has registered there is no key to check a token with: nobody logs in", async () => {
  await app.close();
  app = buildApp({ config: testConfig(), redis, logger: false, karyl: registeredPlugin(null) });
  const account = await boundAccount();

  expect(outcome(await open(pluginSession(bot.privateKey, account.discordId)))).toEqual(refused("invalid"));
});

test("a Discord id bound to no account: no account made, no session, and /login is told the id", async () => {
  const before = await sequelize.query("SELECT count(*)::int AS n FROM accounts", { plain: true });

  const answer = await open(pluginSession(bot.privateKey, DISCORD_ID));

  expect(outcome(answer)).toEqual(refused(`unbound:${DISCORD_ID}`));
  expect(await storedSessions()).toEqual([]);
  expect(await sequelize.query("SELECT count(*)::int AS n FROM accounts", { plain: true })).toEqual(before);
});

test("a disabled account does not log in from a link", async () => {
  const account = await boundAccount();
  await setDisabled(account.id, true);

  expect(outcome(await open(pluginSession(bot.privateKey, account.discordId)))).toEqual(refused("disabled"));
  expect(await storedSessions()).toEqual([]);
});

test("ten links that log nobody in from one IP in 15 minutes, then the eleventh is refused before it is read", async () => {
  const account = await boundAccount();
  // One that logs in counts for nothing.
  signedIn(await open(pluginSession(bot.privateKey, account.discordId), "203.0.113.7"));
  for (let at = 0; at < 10; at += 1) expect(outcome(await open("not-a-token", "203.0.113.7"))).toEqual(refused("invalid"));

  expect(outcome(await open(pluginSession(bot.privateKey, account.discordId), "203.0.113.7"))).toEqual(refused("rate_limited"));
  // Another IP is not held back.
  signedIn(await open(pluginSession(bot.privateKey, account.discordId), "203.0.113.8"));
});

test("the request log never shows the token of a link", () => {
  expect(withoutLinkTokens("/auth/karyl?token=eyJhbGciOi.eyJwdXJwb3Nl.c2lnbmF0dXJl")).toBe("/auth/karyl?token=[token]");
});

test("deployed on its own, the server has no /auth/karyl", async () => {
  await app.close();
  app = buildApp({ config: testConfig(), redis, logger: false });

  const answer = await open(pluginSession(bot.privateKey, DISCORD_ID));
  expect([answer.statusCode, answer.json()]).toEqual([404, { code: "not_found" }]);
});

test("a Bearer token that is no session is 401, and no cookie is cleared for it", async () => {
  const answer = await app.inject({ method: "GET", url: "/api/me", headers: bearer("A".repeat(43)) });

  expect([answer.statusCode, answer.json()]).toEqual([401, { code: "unauthenticated" }]);
  expect(answer.headers["set-cookie"]).toBeUndefined();
});

test("logging out with a Bearer token ends that session only", async () => {
  const account = await boundAccount();
  const first = signedIn(await open(pluginSession(bot.privateKey, account.discordId)));
  const second = signedIn(await open(pluginSession(bot.privateKey, account.discordId)));

  const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin: ORIGIN, ...bearer(first) } });

  expect(out.statusCode).toBe(204);
  expect(out.headers["set-cookie"]).toBeUndefined();
  expect((await app.inject({ method: "GET", url: "/api/me", headers: bearer(first) })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: "/api/me", headers: bearer(second) })).statusCode).toBe(200);
});

test("a Bearer token goes before the cookie, and a password session still logs in with the cookie", async () => {
  const account = await boundAccount();
  const viaCookie = await sessionOf(app, account.username, PASSWORD);
  const viaLink = signedIn(await open(pluginSession(bot.privateKey, account.discordId)));

  const both = await app.inject({ method: "GET", url: "/api/me", headers: bearer(viaLink), cookies: { [COOKIE]: viaCookie } });
  // The link's session: no password to change first. The cookie's would have to.
  expect([both.statusCode, both.json().mustChangePassword]).toEqual([200, false]);
  const cookieOnly = await app.inject({ method: "GET", url: "/api/me", cookies: { [COOKIE]: viaCookie } });
  expect([cookieOnly.statusCode, cookieOnly.json().mustChangePassword]).toEqual([200, true]);
});

test("a Bearer session opens a score on /collab: its collab ticket is the token of the WebSocket's handshake", async () => {
  const account = await boundAccount();
  const sessionId = signedIn(await open(pluginSession(bot.privateKey, account.discordId)));
  // The bot's proxy sends no cookie: the page asks with its Bearer token, from the bot's origin.
  const headers = { origin: ORIGIN, ...bearer(sessionId) };
  const created = await app.inject({ method: "POST", url: "/api/scores", headers, payload: { title: "從 Discord 開的譜" } });
  expect(created.statusCode).toBe(201);
  const scoreId = (created.json() as { id: string }).id;
  const url = await listen(app);

  const score = await openScore(url, scoreId, async () => {
    const answer = await app.inject({ method: "POST", url: `/api/scores/${scoreId}/collab-ticket`, headers });
    return (answer.json() as { ticket: string }).ticket;
  });

  expect(score.doc.getMap("meta").get("title")).toBe("從 Discord 開的譜");
  score.provider.destroy();
});
