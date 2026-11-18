// An admin binds a Discord id to an account and unbinds it (docs/spec/karyl-login.md, section 4;
// docs/spec/routes.md, 3.2).
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";

import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import { Account, Identity } from "../src/db/models";
import { pluginSession, registeredPlugin, signingAuthority } from "./karyl";
import { apiCall, freshDatabase, freshRedis, isActiveSession, sessionOf, testConfig, warmPool } from "./support";

const PASSWORD = "a password long enough";
const NOBODY = "00000000-0000-4000-8000-000000000000";
const bot = signingAuthority();

let sequelize: Sequelize;
let redis: Redis;
let app: FastifyInstance;
let admin: string;
let accounts = 0;
let discordIds = 0;

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  await createAccount({ username: "the-admin", displayName: "管理者", password: PASSWORD, isAdmin: true, mustChangePassword: false });
});

beforeEach(async () => {
  await redis.flushdb();
  app = buildApp({ config: testConfig(), redis, logger: false, karyl: registeredPlugin(bot.publicPem) });
  admin = await sessionOf(app, "the-admin", PASSWORD);
});

afterEach(async () => {
  await app.close();
});

afterAll(async () => {
  await redis.quit();
  await sequelize.close();
});

async function member(): Promise<{ id: string; username: string }> {
  const username = `member-${(accounts += 1)}`;
  const { id } = await createAccount({ username, displayName: "成員", password: PASSWORD, isAdmin: false, mustChangePassword: false });
  return { id, username };
}

/** A Discord id no test has used. */
const newDiscordId = () => `2${String((discordIds += 1)).padStart(17, "0")}`;

const bind = (accountId: string, subject: string, session = admin) => apiCall(app, "POST", `/api/admin/accounts/${accountId}/identities`, session, { provider: "karyl-chan", subject });
const unbind = (accountId: string, identityId: string, session = admin) => apiCall(app, "DELETE", `/api/admin/accounts/${accountId}/identities/${identityId}`, session);

/** Log in from a bot link as this Discord id; the session id, or null when refused. */
async function linkSession(discordId: string): Promise<string | null> {
  const answer = await app.inject({ method: "GET", url: `/auth/karyl?token=${pluginSession(bot.privateKey, discordId)}` });
  return /#session=(.+)$/.exec(String(answer.headers.location))?.[1] ?? null;
}

test("an admin binds a Discord id: the account lists it, and its link logs in to that account", async () => {
  const { id, username } = await member();
  const discordId = newDiscordId();

  const answer = await bind(id, discordId);

  expect(answer.statusCode).toBe(201);
  expect(answer.json()).toMatchObject({
    accountId: id,
    username,
    identities: expect.arrayContaining([
      { id: expect.any(String), provider: "password" },
      { id: expect.any(String), provider: "karyl-chan", subject: discordId },
    ]),
  });
  const listed = (await apiCall(app, "GET", "/api/admin/accounts", admin)).json().accounts.find((account: { accountId: string }) => account.accountId === id);
  expect(listed.identities).toContainEqual({ id: expect.any(String), provider: "karyl-chan", subject: discordId });
  const session = await linkSession(discordId);
  expect((await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${session}` } })).json()).toMatchObject({ username });
});

test("a Discord id is bound to one account, and an account has one Discord id: the second binding is 409", async () => {
  const first = await member();
  const second = await member();
  const discordId = newDiscordId();
  expect((await bind(first.id, discordId)).statusCode).toBe(201);

  const taken = await bind(second.id, discordId);
  const another = await bind(first.id, newDiscordId());

  expect([taken.statusCode, taken.json()]).toEqual([409, { code: "identity_taken" }]);
  expect([another.statusCode, another.json()]).toEqual([409, { code: "identity_taken" }]);
  expect(await Identity.count({ where: { provider: "karyl-chan", accountId: [first.id, second.id] } })).toBe(1);
});

test("two bindings of one account at once: one of them", async () => {
  await warmPool(sequelize);
  const { id } = await member();

  const answers = await Promise.all([bind(id, newDiscordId()), bind(id, newDiscordId())]);

  expect(answers.map((answer) => answer.statusCode).sort()).toEqual([201, 409]);
  expect(await Identity.count({ where: { provider: "karyl-chan", accountId: id } })).toBe(1);
});

test("what is no Discord id, or no karyl-chan binding, is 400; no such account is 404", async () => {
  const { id } = await member();
  for (const body of [{ provider: "karyl-chan", subject: "12345" }, { provider: "karyl-chan", subject: "abc456789012345678" }, { provider: "password", subject: newDiscordId() }, { provider: "karyl-chan" }]) {
    const answer = await apiCall(app, "POST", `/api/admin/accounts/${id}/identities`, admin, body);
    expect([body, answer.statusCode, answer.json().code]).toEqual([body, 400, "invalid_request"]);
  }
  for (const accountId of [NOBODY, "not-an-id"]) expect((await bind(accountId, newDiscordId())).statusCode).toBe(404);
});

test("unbinding: the id logs into nothing, the sessions its links started end, the password's stay", async () => {
  const { id, username } = await member();
  const discordId = newDiscordId();
  const identityId = (await bind(id, discordId)).json().identities.find((identity: { provider: string }) => identity.provider === "karyl-chan").id;
  const fromLink = (await linkSession(discordId))!;
  const fromPassword = await sessionOf(app, username, PASSWORD);

  const answer = await unbind(id, identityId);

  expect(answer.statusCode).toBe(204);
  expect((await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${fromLink}` } })).statusCode).toBe(401);
  expect(await isActiveSession(app, fromPassword)).toBe(true);
  expect(await linkSession(discordId)).toBeNull();
  // Free again, for this account or another.
  expect((await bind((await member()).id, discordId)).statusCode).toBe(201);
});

test("the password is not unbound (400); an identity of another account, or none, is 404", async () => {
  const { id } = await member();
  const other = await member();
  const password = (await Identity.findOne({ where: { accountId: id, provider: "password" } }))!;
  const othersBinding = (await bind(other.id, newDiscordId())).json().identities.find((identity: { provider: string }) => identity.provider === "karyl-chan").id;

  expect([(await unbind(id, password.id)).statusCode, (await unbind(id, password.id)).json()]).toEqual([400, { code: "invalid_request" }]);
  expect((await unbind(id, othersBinding)).statusCode).toBe(404);
  expect((await unbind(id, NOBODY)).statusCode).toBe(404);
  expect(await Identity.count({ where: { id: [password.id, othersBinding] } })).toBe(2);
});

test("to anyone but an admin, binding and unbinding are not there", async () => {
  const { id, username } = await member();
  const session = await sessionOf(app, username, PASSWORD);
  const bound = await Identity.create({ accountId: (await Account.findOne({ where: { username: "the-admin" } }))!.id, provider: "karyl-chan", subject: newDiscordId() });

  expect((await bind(id, newDiscordId(), session)).statusCode).toBe(404);
  expect((await unbind(bound.accountId, bound.id, session)).statusCode).toBe(404);
  expect(await Identity.count({ where: { provider: "karyl-chan", accountId: id } })).toBe(0);
});
