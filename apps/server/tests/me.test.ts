// One's own account: having to change a temporary password first, changing the password, the
// display name, and logging out everywhere (docs/spec/accounts.md, section 1; docs/spec/routes.md, 3.1).
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import { Account } from "../src/db/models";
import { holdClock } from "./clock";
import { apiCall, freshDatabase, freshRedis, isActiveSession, login, sessionCookie, sessionOf, testConfig, whoAmI } from "./support";

const TEMPORARY = "a temporary password";
const PASSWORD = "a password long enough";
const NEW_PASSWORD = "another password, chosen";

let sequelize: Sequelize;
let redis: Redis;
let app: FastifyInstance;
let usernames = 0;

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
});

beforeEach(async () => {
  await redis.flushdb();
  app = buildApp({ config: testConfig(), redis, logger: false });
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await redis.quit();
  await sequelize.close();
});

/** A new account of its own for each test: one an admin made (a temporary password), or one that chose its password. */
async function account(mustChangePassword: boolean): Promise<{ id: string; username: string; password: string }> {
  const username = `member-${(usernames += 1)}`;
  const password = mustChangePassword ? TEMPORARY : PASSWORD;
  const { id } = await createAccount({ username, displayName: "原本的名稱", password, isAdmin: false, mustChangePassword });
  return { id, username, password };
}

const send = (method: "GET" | "POST" | "PATCH", url: string, session: string, payload?: object) => apiCall(app, method, url, session, payload);

const changePassword = (session: string, payload: object) => send("POST", "/api/me/password", session, payload);

const valid = (session: string) => isActiveSession(app, session);

test("an account that must change its password is refused everything else with 403 password_change_required, until it has", async () => {
  const member = await account(true);
  // A route as a later ticket would add it, without saying anything about passwords.
  app.get("/api/later-things", async () => ({ things: [] }));
  const session = await sessionOf(app, member.username, member.password);
  const others = () =>
    Promise.all([send("GET", "/api/scores", session), send("POST", "/api/scores", session, { title: "團譜" }), send("PATCH", "/api/me", session, { displayName: "新的名稱" }), send("GET", "/api/later-things", session)]);

  for (const response of await others()) expect([response.statusCode, response.json()]).toEqual([403, { code: "password_change_required" }]);
  // Whose session it is can still be read: the page learns from it where to send them.
  expect((await whoAmI(app, session)).json()).toMatchObject({ username: member.username, mustChangePassword: true });

  // The temporary password was just typed to log in: it is not asked for again.
  expect((await changePassword(session, { newPassword: NEW_PASSWORD })).statusCode).toBe(204);

  expect((await others()).map((response) => response.statusCode)).toEqual([200, 201, 200, 200]);
  expect((await whoAmI(app, session)).json()).toMatchObject({ mustChangePassword: false });
  expect((await login(app, member.username, TEMPORARY)).statusCode).toBe(401);
  expect((await login(app, member.username, NEW_PASSWORD)).statusCode).toBe(204);
});

test("an account that must change its password can still log out, here or everywhere", async () => {
  const member = await account(true);
  const [here, there] = [await sessionOf(app, member.username, member.password), await sessionOf(app, member.username, member.password)];
  expect((await send("POST", "/api/auth/logout", here)).statusCode).toBe(204);
  expect([await valid(here), await valid(there)]).toEqual([false, true]);
  expect((await send("POST", "/api/auth/logout-all", there)).statusCode).toBe(204);
  expect(await valid(there)).toBe(false);
});

test("a session that did not log in with the password is not held to changing it", async () => {
  const member = await account(true);
  // As the karyl-chan login starts its sessions (#72).
  const session = await app.sessions.start(member.id, "karyl-chan");
  expect((await send("GET", "/api/scores", session)).statusCode).toBe(200);
  expect((await whoAmI(app, session)).json()).toMatchObject({ mustChangePassword: false });
  // It never typed the temporary password, so it is asked for the current one like anyone else.
  expect((await changePassword(session, { newPassword: NEW_PASSWORD })).statusCode).toBe(400);
  expect((await Account.findByPk(member.id))!.mustChangePassword).toBe(true);
});

test("a session stored before sessions said how they logged in counts as a password login", async () => {
  const member = await account(true);
  const session = await sessionOf(app, member.username, member.password);
  await redis.set(`session:${session}`, JSON.stringify({ accountId: member.id, createdAt: new Date().toISOString() }));
  expect((await send("GET", "/api/scores", session)).json()).toEqual({ code: "password_change_required" });
});

test("changing the password keeps this session, ends the account's others, and tells the listeners", async () => {
  const [member, other] = [await account(false), await account(false)];
  const [here, there, others] = [
    await sessionOf(app, member.username, member.password),
    await sessionOf(app, member.username, member.password),
    await sessionOf(app, other.username, other.password),
  ];
  const listener = vi.fn();
  app.sessions.onEnd(listener);

  const response = await changePassword(here, { currentPassword: member.password, newPassword: NEW_PASSWORD });

  expect(response.statusCode).toBe(204);
  expect([await valid(here), await valid(there), await valid(others)]).toEqual([true, false, true]);
  // The whole account: its connections close, this session's included, and come back with a new ticket.
  expect(listener.mock.calls).toEqual([[{ accountId: member.id, sessionId: null }]]);
  expect((await login(app, member.username, member.password)).statusCode).toBe(401);
  expect((await login(app, member.username, NEW_PASSWORD)).statusCode).toBe(204);
});

test("a password that changed is answered as changed even when ending the other sessions fails, and the listeners are still told", async () => {
  const member = await account(false);
  const [here, there] = [await sessionOf(app, member.username, member.password), await sessionOf(app, member.username, member.password)];
  const listener = vi.fn();
  app.sessions.onEnd(listener);
  // Redis fails as the other sessions are deleted.
  const end = app.sessions.end.bind(app.sessions);
  const multi = redis.multi.bind(redis);
  const failing = vi.spyOn(redis, "multi");
  vi.spyOn(app.sessions, "end").mockImplementationOnce(async (which) => {
    failing.mockImplementationOnce(() => {
      const removal = multi();
      removal.exec = async () => {
        throw new Error("Redis is away");
      };
      return removal;
    });
    return end(which);
  });

  const response = await changePassword(here, { currentPassword: member.password, newPassword: NEW_PASSWORD });
  failing.mockRestore();

  // Not an error: the old password is gone, and trying again with it would only be refused.
  expect(response.statusCode).toBe(204);
  expect((await login(app, member.username, member.password)).statusCode).toBe(401);
  expect((await login(app, member.username, NEW_PASSWORD)).statusCode).toBe(204);
  // The connections close whatever Redis did; the session that could not be ended is still there.
  expect(listener.mock.calls).toEqual([[{ accountId: member.id, sessionId: null }]]);
  expect([await valid(here), await valid(there)]).toEqual([true, true]);
});

test("logging out everywhere ends this session too, and tells the listeners", async () => {
  const member = await account(false);
  const [here, there] = [await sessionOf(app, member.username, member.password), await sessionOf(app, member.username, member.password)];
  const listener = vi.fn();
  app.sessions.onEnd(listener);

  const response = await send("POST", "/api/auth/logout-all", here);

  expect(response.statusCode).toBe(204);
  expect(sessionCookie(response)).toMatchObject({ value: "" });
  expect([await valid(here), await valid(there)]).toEqual([false, false]);
  expect(listener.mock.calls).toEqual([[{ accountId: member.id, sessionId: null }]]);
});

test("a new password of 9 or 257 characters is refused, one of 10 or 256 accepted", async () => {
  const member = await account(false);
  const session = await sessionOf(app, member.username, member.password);
  let current = member.password;
  for (const [length, accepted] of [[9, false], [257, false], [10, true], [256, true]] as const) {
    const newPassword = "密".repeat(length);
    const response = await changePassword(session, { currentPassword: current, newPassword });
    if (accepted) {
      expect(response.statusCode).toBe(204);
      current = newPassword;
    } else {
      expect([response.statusCode, response.json()]).toEqual([400, { code: "invalid_request", params: { issues: [{ path: ["newPassword"], code: expect.any(String) }] } }]);
    }
  }
  expect((await login(app, member.username, "密".repeat(256))).statusCode).toBe(204);
});

test("a wrong current password, or none, changes nothing and ends no session", async () => {
  const member = await account(false);
  const [here, there] = [await sessionOf(app, member.username, member.password), await sessionOf(app, member.username, member.password)];

  const wrong = await changePassword(here, { currentPassword: "not the password", newPassword: NEW_PASSWORD });
  const none = await changePassword(here, { newPassword: NEW_PASSWORD });

  expect([wrong.statusCode, wrong.json()]).toEqual([403, { code: "wrong_current_password" }]);
  expect([none.statusCode, none.json()]).toEqual([400, { code: "invalid_request", params: { issues: [{ path: ["currentPassword"], code: "invalid_type" }] } }]);
  expect([await valid(here), await valid(there)]).toEqual([true, true]);
  expect((await login(app, member.username, member.password)).statusCode).toBe(204);
});

test("the eleventh wrong guess of the current password in 15 minutes is refused; right ones do not count", async () => {
  holdClock();
  const member = await account(false);
  const session = await sessionOf(app, member.username, member.password);
  let current = member.password;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = `${NEW_PASSWORD} ${attempt}`;
    expect((await changePassword(session, { currentPassword: current, newPassword: next })).statusCode).toBe(204);
    current = next;
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    expect((await changePassword(session, { currentPassword: "not the password", newPassword: NEW_PASSWORD })).statusCode).toBe(403);
  }
  // Even the right one now: the limit is on asking.
  const limited = await changePassword(session, { currentPassword: current, newPassword: NEW_PASSWORD });
  expect([limited.statusCode, limited.json()]).toEqual([429, { code: "rate_limited" }]);
  expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
});

test("a display name is trimmed and kept; an empty one or one over 50 characters is refused", async () => {
  const member = await account(false);
  const session = await sessionOf(app, member.username, member.password);

  const renamed = await send("PATCH", "/api/me", session, { displayName: "  新的名稱  " });
  expect([renamed.statusCode, renamed.json()]).toEqual([200, expect.objectContaining({ username: member.username, displayName: "新的名稱" })]);
  expect((await whoAmI(app, session)).json()).toMatchObject({ displayName: "新的名稱" });

  for (const displayName of ["   ", "名".repeat(51)]) {
    expect((await send("PATCH", "/api/me", session, { displayName })).statusCode).toBe(400);
  }
  expect((await send("PATCH", "/api/me", session, { displayName: "名".repeat(50) })).statusCode).toBe(200);
});
