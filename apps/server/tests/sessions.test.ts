// Ending sessions: the one function every way of ending them goes through, and its listeners
// (docs/spec/security.md, section 1; docs/spec/accounts.md, section 9).
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import type { SessionsEnded } from "../src/sessions";
import { COOKIE, freshDatabase, freshRedis, ORIGIN, sessionOf, testConfig, whoAmI } from "./support";

const PASSWORD = "a password long enough";

let sequelize: Sequelize;
let redis: Redis;
let app: FastifyInstance;
let anna: string;

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  const account = (username: string) => createAccount({ username, displayName: username, password: PASSWORD, isAdmin: false, mustChangePassword: false });
  anna = (await account("anna")).id;
  await account("ben");
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


async function valid(session: string): Promise<boolean> {
  return (await whoAmI(app, session)).statusCode === 200;
}

test("ending an account's sessions ends every one of them, keeps other accounts', and tells every listener", async () => {
  const [annaHere, annaThere, ben] = [await sessionOf(app, "anna", PASSWORD), await sessionOf(app, "anna", PASSWORD), await sessionOf(app, "ben", PASSWORD)];
  const first = vi.fn<(ended: SessionsEnded) => void>();
  const second = vi.fn<(ended: SessionsEnded) => Promise<void>>(async () => {});
  app.sessions.onEnd(first);
  app.sessions.onEnd(second);

  await app.sessions.end({ accountId: anna });

  expect([await valid(annaHere), await valid(annaThere), await valid(ben)]).toEqual([false, false, true]);
  for (const listener of [first, second]) expect(listener.mock.calls).toEqual([[{ accountId: anna, sessionId: null }]]);
});

test("a listener that fails keeps neither the sessions alive nor the other listeners from being told", async () => {
  const session = await sessionOf(app, "anna", PASSWORD);
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
  const [kept, ended] = [await sessionOf(app, "anna", PASSWORD), await sessionOf(app, "anna", PASSWORD)];
  const listener = vi.fn();
  app.sessions.onEnd(listener);

  await app.sessions.end({ accountId: anna, except: kept });

  expect([await valid(kept), await valid(ended)]).toEqual([true, false]);
  expect(listener.mock.calls).toEqual([[{ accountId: anna, sessionId: null }]]);
});

test("logging out goes through the same function and tells the listeners which session ended", async () => {
  const [leaving, staying] = [await sessionOf(app, "anna", PASSWORD), await sessionOf(app, "anna", PASSWORD)];
  const listener = vi.fn();
  app.sessions.onEnd(listener);

  await app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin: ORIGIN }, cookies: { [COOKIE]: leaving } });

  expect([await valid(leaving), await valid(staying)]).toEqual([false, true]);
  expect(listener.mock.calls).toEqual([[{ accountId: anna, sessionId: leaving }]]);
});

test("a listener can stop listening", async () => {
  await sessionOf(app, "anna", PASSWORD);
  const listener = vi.fn();
  const stop = app.sessions.onEnd(listener);
  stop();
  await app.sessions.end({ accountId: anna });
  expect(listener).not.toHaveBeenCalled();
});

test("a session whose deletion Redis ran but never answered still has its listeners told, without the account", async () => {
  const [leaving, staying] = [await sessionOf(app, "anna", PASSWORD), await sessionOf(app, "anna", PASSWORD)];
  const listener = vi.fn();
  app.sessions.onEnd(listener);
  // Redis deletes the session; its reply is lost on the way back.
  const getdel = redis.getdel.bind(redis);
  vi.spyOn(redis, "getdel").mockImplementationOnce(async (key) => {
    await getdel(key);
    throw new Error("the reply was lost");
  });

  await expect(app.sessions.end({ sessionId: leaving })).rejects.toThrow("the reply was lost");

  expect(listener.mock.calls).toEqual([[{ accountId: null, sessionId: leaving }]]);
  expect([await valid(leaving), await valid(staying)]).toEqual([false, true]);
});

test("a session that had already ended tells no listener", async () => {
  const session = await sessionOf(app, "anna", PASSWORD);
  await app.sessions.end({ sessionId: session });
  const listener = vi.fn();
  app.sessions.onEnd(listener);

  await app.sessions.end({ sessionId: session });

  expect(listener).not.toHaveBeenCalled();
});

test.each([
  ["is not JSON", "not JSON"],
  ["names no account", "{}"],
])("a session whose stored value %s still ends and has its listeners told, without the account", async (_, stored) => {
  const session = await sessionOf(app, "anna", PASSWORD);
  await redis.set(`session:${session}`, stored);
  const listener = vi.fn();
  app.sessions.onEnd(listener);
  const srem = vi.spyOn(redis, "srem");

  await app.sessions.end({ sessionId: session });

  expect(listener.mock.calls).toEqual([[{ accountId: null, sessionId: session }]]);
  expect(await redis.exists(`session:${session}`)).toBe(0);
  // No account, no list to take the session off.
  expect(srem).not.toHaveBeenCalled();
  srem.mockRestore();
});
