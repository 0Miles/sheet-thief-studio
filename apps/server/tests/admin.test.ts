// What an admin does on /admin: making accounts, resetting passwords, disabling and enabling;
// and that nobody else can (docs/spec/routes.md, 3.2; docs/spec/accounts.md, section 2).
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import { Account } from "../src/db/models";
import { apiCall, freshDatabase, freshRedis, isActiveSession, login, sessionOf, testConfig, whoAmI } from "./support";

const PASSWORD = "a password long enough";
const TEMPORARY = "a temporary password";
const NOBODY = "00000000-0000-4000-8000-000000000000";

let sequelize: Sequelize;
let redis: Redis;
let app: FastifyInstance;
let admin: { id: string; session: string };
let usernames = 0;

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  await createAccount({ username: "the-admin", displayName: "管理者", password: PASSWORD, isAdmin: true, mustChangePassword: false });
});

beforeEach(async () => {
  await redis.flushdb();
  app = buildApp({ config: testConfig(), redis, logger: false });
  admin = { id: (await Account.findOne({ where: { username: "the-admin" } }))!.id, session: await sessionOf(app, "the-admin", PASSWORD) };
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await redis.quit();
  await sequelize.close();
});

/** A new account of its own for each test, which chose its password; no admin. */
async function member(): Promise<{ id: string; username: string }> {
  const username = `member-${(usernames += 1)}`;
  const { id } = await createAccount({ username, displayName: "成員", password: PASSWORD, isAdmin: false, mustChangePassword: false });
  return { id, username };
}

const send = (method: "GET" | "POST", url: string, session: string, payload?: object) => apiCall(app, method, url, session, payload);

const create = (payload: object, session = admin.session) => send("POST", "/api/admin/accounts", session, payload);

const valid = (session: string) => isActiveSession(app, session);

test("an admin makes an account, which logs in with the temporary password and must change it", async () => {
  const response = await create({ username: "new_one-1", displayName: "  新來的  ", password: TEMPORARY });

  expect(response.statusCode).toBe(201);
  expect(response.json()).toEqual({
    accountId: expect.any(String),
    username: "new_one-1",
    displayName: "新來的",
    isAdmin: false,
    disabled: false,
    identities: [{ id: expect.any(String), provider: "password" }],
  });
  const session = await sessionOf(app, "new_one-1", TEMPORARY);
  expect((await whoAmI(app, session)).json()).toMatchObject({ username: "new_one-1", isAdmin: false, mustChangePassword: true });
});

test("a username that breaks the rules is refused: Ab, a, 33 characters, one with a space", async () => {
  for (const username of ["Ab", "a", "a".repeat(33), "with space", "ab", "Abc", "名稱名稱"]) {
    const response = await create({ username, displayName: "名稱", password: TEMPORARY });
    expect([username, response.statusCode, response.json()]).toEqual([username, 400, { code: "invalid_request", params: { issues: [{ path: ["username"], code: expect.any(String) }] } }]);
  }
  for (const username of ["abc", "a".repeat(32), "a-b_9"]) {
    expect([username, (await create({ username, displayName: "名稱", password: TEMPORARY })).statusCode]).toEqual([username, 201]);
  }
});

test("a username that exists is refused with 409 username_taken", async () => {
  const { username } = await member();
  const response = await create({ username, displayName: "另一個", password: TEMPORARY });
  expect([response.statusCode, response.json()]).toEqual([409, { code: "username_taken" }]);
});

test("an initial password of 9 characters or a display name of 51 is refused", async () => {
  expect((await create({ username: "short-password", displayName: "名稱", password: "密".repeat(9) })).statusCode).toBe(400);
  expect((await create({ username: "long-name", displayName: "名".repeat(51), password: TEMPORARY })).statusCode).toBe(400);
});

test("the list shows every account by username: its names, whether it is an admin, whether it is disabled", async () => {
  const { id, username } = await member();
  await Account.update({ disabledAt: new Date() }, { where: { id } });

  const response = await send("GET", "/api/admin/accounts", admin.session);

  expect(response.statusCode).toBe(200);
  const { accounts } = response.json() as { accounts: Array<{ username: string }> };
  expect(accounts.map((account) => account.username)).toEqual(accounts.map((account) => account.username).sort());
  expect(accounts).toContainEqual({ accountId: id, username, displayName: "成員", isAdmin: false, disabled: true, identities: [{ id: expect.any(String), provider: "password" }] });
  expect(accounts).toContainEqual(expect.objectContaining({ accountId: admin.id, username: "the-admin", isAdmin: true, disabled: false }));
});

test("anyone but an admin is answered 404 by every admin API, and nothing happens", async () => {
  const [caller, target] = [await member(), await member()];
  const session = await sessionOf(app, caller.username, PASSWORD);
  const targetSession = await sessionOf(app, target.username, PASSWORD);

  const responses = [
    await send("GET", "/api/admin/accounts", session),
    await create({ username: "by-a-member", displayName: "名稱", password: TEMPORARY }, session),
    await send("POST", `/api/admin/accounts/${target.id}/reset-password`, session, { password: TEMPORARY }),
    await send("POST", `/api/admin/accounts/${target.id}/disable`, session),
    await send("POST", `/api/admin/accounts/${target.id}/enable`, session),
    // Its own account too, and a request that would be refused as invalid from an admin.
    await send("POST", `/api/admin/accounts/${caller.id}/disable`, session),
    await create({}, session),
  ];

  for (const response of responses) expect([response.statusCode, response.json()]).toEqual([404, { code: "not_found" }]);
  expect(await Account.findOne({ where: { username: "by-a-member" } })).toBeNull();
  expect((await Account.findByPk(target.id))!).toMatchObject({ disabledAt: null, mustChangePassword: false });
  expect(await valid(targetSession)).toBe(true);
  expect((await login(app, target.username, PASSWORD)).statusCode).toBe(204);
});

test("a route added under /api/admin/ later is closed to anyone but an admin without saying so", async () => {
  // As a later ticket would add it (#16), without a check of its own; routes are added before the app starts.
  await app.close();
  app = buildApp({ config: testConfig(), redis, logger: false });
  app.get("/api/admin/later-things", async () => ({ things: [] }));
  const { username } = await member();
  expect((await send("GET", "/api/admin/later-things", await sessionOf(app, username, PASSWORD))).statusCode).toBe(404);
  expect((await send("GET", "/api/admin/later-things", admin.session)).statusCode).toBe(200);
});

test("nobody logged in is answered 401 by the admin APIs, like by any other", async () => {
  const response = await app.inject({ method: "GET", url: "/api/admin/accounts" });
  expect([response.statusCode, response.json()]).toEqual([401, { code: "unauthenticated" }]);
});

test("a session that must change its password first is answered 403 by the admin APIs, admin or not: that check comes before the admin's", async () => {
  await createAccount({ username: "temporary-admin", displayName: "管理者", password: TEMPORARY, isAdmin: true, mustChangePassword: true });
  await createAccount({ username: "temporary-member", displayName: "成員", password: TEMPORARY, isAdmin: false, mustChangePassword: true });
  const target = await member();
  for (const username of ["temporary-admin", "temporary-member"]) {
    const session = await sessionOf(app, username, TEMPORARY);
    const responses = [
      await send("GET", "/api/admin/accounts", session),
      await create({ username: `by-${username}`, displayName: "名稱", password: TEMPORARY }, session),
      await send("POST", `/api/admin/accounts/${target.id}/disable`, session),
    ];
    for (const response of responses) expect([username, response.statusCode, response.json()]).toEqual([username, 403, { code: "password_change_required" }]);
    expect(await Account.findOne({ where: { username: `by-${username}` } })).toBeNull();
  }
  expect((await Account.findByPk(target.id))!.disabledAt).toBeNull();
});

test("resetting the password of an account that does not exist is answered 404 whatever the body", async () => {
  for (const id of [NOBODY, "not-an-id"]) {
    for (const payload of [{}, { password: "short" }]) {
      const response = await send("POST", `/api/admin/accounts/${id}/reset-password`, admin.session, payload);
      expect([response.statusCode, response.json()]).toEqual([404, { code: "not_found" }]);
    }
  }
});

test("disabling an account ends all its sessions and refuses its logins; enabling lets it log in again", async () => {
  const [target, other] = [await member(), await member()];
  const sessions = [await sessionOf(app, target.username, PASSWORD), await sessionOf(app, target.username, PASSWORD)];
  const others = await sessionOf(app, other.username, PASSWORD);
  const listener = vi.fn();
  app.sessions.onEnd(listener);

  const disabled = await send("POST", `/api/admin/accounts/${target.id}/disable`, admin.session);

  expect(disabled.statusCode).toBe(204);
  // Through the function every ended session goes through: the account's /collab connections close.
  expect(listener.mock.calls).toEqual([[{ accountId: target.id, sessionId: null }]]);
  expect(await redis.exists(`session:${sessions[0]}`, `session:${sessions[1]}`, `account-sessions:${target.id}`)).toBe(0);
  expect([await valid(sessions[0]!), await valid(sessions[1]!), await valid(others), await valid(admin.session)]).toEqual([false, false, true, true]);
  const refused = await login(app, target.username, PASSWORD);
  expect([refused.statusCode, refused.json()]).toEqual([401, { code: "invalid_credentials" }]);

  // Disabling again changes nothing, and is no error.
  const since = (await Account.findByPk(target.id))!.disabledAt;
  expect((await send("POST", `/api/admin/accounts/${target.id}/disable`, admin.session)).statusCode).toBe(204);
  expect((await Account.findByPk(target.id))!.disabledAt).toEqual(since);

  const enabled = await send("POST", `/api/admin/accounts/${target.id}/enable`, admin.session);

  expect(enabled.statusCode).toBe(204);
  expect((await login(app, target.username, PASSWORD)).statusCode).toBe(204);
  // The sessions that ended stay ended.
  expect(await valid(sessions[0]!)).toBe(false);
});

test("an admin cannot disable their own account", async () => {
  const response = await send("POST", `/api/admin/accounts/${admin.id}/disable`, admin.session);
  expect([response.statusCode, response.json()]).toEqual([409, { code: "cannot_disable_self" }]);
  expect((await Account.findByPk(admin.id))!.disabledAt).toBeNull();
  expect(await valid(admin.session)).toBe(true);
});

test("resetting a password ends the account's sessions, and the new one must be changed at the next login", async () => {
  const [target, other] = [await member(), await member()];
  const sessions = [await sessionOf(app, target.username, PASSWORD), await sessionOf(app, target.username, PASSWORD)];
  const others = await sessionOf(app, other.username, PASSWORD);
  const listener = vi.fn();
  app.sessions.onEnd(listener);

  const response = await send("POST", `/api/admin/accounts/${target.id}/reset-password`, admin.session, { password: TEMPORARY });

  expect(response.statusCode).toBe(204);
  expect(listener.mock.calls).toEqual([[{ accountId: target.id, sessionId: null }]]);
  expect([await valid(sessions[0]!), await valid(sessions[1]!), await valid(others)]).toEqual([false, false, true]);
  expect((await Account.findByPk(target.id))!.mustChangePassword).toBe(true);
  expect((await login(app, target.username, PASSWORD)).statusCode).toBe(401);
  const session = await sessionOf(app, target.username, TEMPORARY);
  expect((await whoAmI(app, session)).json()).toMatchObject({ mustChangePassword: true });
  expect((await send("GET", "/api/scores", session)).json()).toEqual({ code: "password_change_required" });
});

test("a temporary password of 9 or 257 characters is refused, and the old one stays", async () => {
  const target = await member();
  const session = await sessionOf(app, target.username, PASSWORD);
  for (const length of [9, 257]) {
    const response = await send("POST", `/api/admin/accounts/${target.id}/reset-password`, admin.session, { password: "密".repeat(length) });
    expect([response.statusCode, response.json()]).toEqual([400, { code: "invalid_request", params: { issues: [{ path: ["password"], code: expect.any(String) }] } }]);
  }
  expect(await valid(session)).toBe(true);
  expect((await Account.findByPk(target.id))!.mustChangePassword).toBe(false);
});

test("an account that does not exist, or an id that is none, is answered 404", async () => {
  for (const id of [NOBODY, "not-an-id"]) {
    const responses = [
      await send("POST", `/api/admin/accounts/${id}/reset-password`, admin.session, { password: TEMPORARY }),
      await send("POST", `/api/admin/accounts/${id}/disable`, admin.session),
      await send("POST", `/api/admin/accounts/${id}/enable`, admin.session),
    ];
    for (const response of responses) expect([response.statusCode, response.json()]).toEqual([404, { code: "not_found" }]);
  }
});

test("the admin flag cannot be set through the API: an account made on /admin is no admin", async () => {
  const response = await create({ username: "would-be-admin", displayName: "名稱", password: TEMPORARY, isAdmin: true, mustChangePassword: false });
  expect(response.statusCode).toBe(201);
  expect((await Account.findOne({ where: { username: "would-be-admin" } }))!).toMatchObject({ isAdmin: false, mustChangePassword: true });
});
