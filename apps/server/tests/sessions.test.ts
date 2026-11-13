// Ending sessions: the one function every way of ending them goes through, and its listeners
// (docs/spec/security.md, section 1; docs/spec/accounts.md, section 9).
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import type { SessionsEnded } from "../src/sessions";
import { COOKIE, freshDatabase, freshRedis, login, ORIGIN, sessionCookie, testConfig, whoAmI } from "./support";

const PASSWORD = "a password long enough";

let sequelize: Sequelize;
let redis: Redis;
let app: FastifyInstance;
let anna: string;

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  for (const username of ["anna", "ben"]) {
    const account = await createAccount({ username, displayName: username, password: PASSWORD, isAdmin: false, mustChangePassword: false });
    if (username === "anna") anna = account.id;
  }
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

async function sessionOf(username: string): Promise<string> {
  return sessionCookie(await login(app, username, PASSWORD))!.value;
}

async function valid(session: string): Promise<boolean> {
  return (await whoAmI(app, session)).statusCode === 200;
}

test("ending an account's sessions ends every one of them, keeps other accounts', and tells every listener", async () => {
  const [annaHere, annaThere, ben] = [await sessionOf("anna"), await sessionOf("anna"), await sessionOf("ben")];
  const first = vi.fn<(ended: SessionsEnded) => void>();
  const second = vi.fn<(ended: SessionsEnded) => Promise<void>>(async () => {});
  app.sessions.onEnd(first);
  app.sessions.onEnd(second);

  await app.sessions.end({ accountId: anna });

  expect([await valid(annaHere), await valid(annaThere), await valid(ben)]).toEqual([false, false, true]);
  for (const listener of [first, second]) expect(listener.mock.calls).toEqual([[{ accountId: anna, sessionId: null }]]);
});

test("a listener that fails keeps neither the sessions alive nor the other listeners from being told", async () => {
  const session = await sessionOf("anna");
  const told = vi.fn();
  app.sessions.onEnd(() => {
    throw new Error("cannot close the connections");
  });
  app.sessions.onEnd(told);

  await app.sessions.end({ accountId: anna });

  expect(await valid(session)).toBe(false);
  expect(told).toHaveBeenCalledOnce();
});

test("ending all but one session keeps that one, and still tells the listeners about the whole account", async () => {
  const [kept, ended] = [await sessionOf("anna"), await sessionOf("anna")];
  const listener = vi.fn();
  app.sessions.onEnd(listener);

  await app.sessions.end({ accountId: anna, except: kept });

  expect([await valid(kept), await valid(ended)]).toEqual([true, false]);
  expect(listener.mock.calls).toEqual([[{ accountId: anna, sessionId: null }]]);
});

test("logging out goes through the same function and tells the listeners which session ended", async () => {
  const [leaving, staying] = [await sessionOf("anna"), await sessionOf("anna")];
  const listener = vi.fn();
  app.sessions.onEnd(listener);

  await app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin: ORIGIN }, cookies: { [COOKIE]: leaving } });

  expect([await valid(leaving), await valid(staying)]).toEqual([false, true]);
  expect(listener.mock.calls).toEqual([[{ accountId: anna, sessionId: leaving }]]);
});

test("a listener can stop listening", async () => {
  await sessionOf("anna");
  const listener = vi.fn();
  const stop = app.sessions.onEnd(listener);
  stop();
  await app.sessions.end({ accountId: anna });
  expect(listener).not.toHaveBeenCalled();
});
