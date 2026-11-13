// The login rate limit (docs/spec/security.md, section 4): per username and per IP, each at most
// 10 failed logins in a 15-minute window.
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import { freshDatabase, freshRedis, login, testConfig } from "./support";

const PASSWORD = "a password long enough";

let sequelize: Sequelize;
let redis: Redis;
let app: FastifyInstance;

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  app = buildApp({ config: testConfig(), redis, logger: false });
  await createAccount({ username: "miles", displayName: "Miles", password: PASSWORD, isAdmin: false, mustChangePassword: false });
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await app.close();
  await redis.quit();
  await sequelize.close();
});

async function statuses(attempts: Array<[username: string, password: string, ip: string]>): Promise<number[]> {
  const answers: number[] = [];
  for (const [username, password, remoteAddress] of attempts) answers.push((await login(app, username, password, { remoteAddress })).statusCode);
  return answers;
}

const times = <T>(count: number, make: (index: number) => T): T[] => Array.from({ length: count }, (_, index) => make(index));

test("the 11th failed login for one username within 15 minutes is refused, whatever the IP and the password", async () => {
  expect(await statuses(times(10, (i) => ["miles", "wrong", `10.0.0.${i + 1}`]))).toEqual(times(10, () => 401));
  const refused = await login(app, "miles", PASSWORD, { remoteAddress: "10.0.1.1" });
  expect(refused.statusCode).toBe(429);
  expect(refused.json()).toEqual({ code: "rate_limited" });
  const retryAfter = Number(refused.headers["retry-after"]);
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(15 * 60);
  // Usernames are counted as stored: case and spaces do not make another one.
  expect((await login(app, " Miles ", PASSWORD, { remoteAddress: "10.0.1.2" })).statusCode).toBe(429);
});

test("one IP is counted across usernames, and another IP is not held back by it", async () => {
  expect(await statuses(times(10, (i) => [`someone-${i}`, "wrong", "10.1.0.1"]))).toEqual(times(10, () => 401));
  expect((await login(app, "miles", PASSWORD, { remoteAddress: "10.1.0.1" })).statusCode).toBe(429);
  expect((await login(app, "miles", PASSWORD, { remoteAddress: "10.1.0.2" })).statusCode).toBe(204);
});

test("a successful login does not count as an attempt", async () => {
  expect(await statuses(times(9, () => ["miles", "wrong", "10.2.0.1"]))).toEqual(times(9, () => 401));
  expect(await statuses([["miles", PASSWORD, "10.2.0.1"], ["miles", "wrong", "10.2.0.1"], ["miles", PASSWORD, "10.2.0.1"]])).toEqual([204, 401, 429]);
});

test("behind the proxy, the IP counted is the one it forwards; a client that is not the proxy cannot choose it", async () => {
  const fromProxy = (username: string, password: string, forwardedFor: string) => login(app, username, password, { remoteAddress: "127.0.0.1", forwardedFor });
  for (let i = 0; i < 10; i++) expect((await fromProxy(`someone-${i}`, "wrong", "203.0.113.7")).statusCode).toBe(401);
  expect((await fromProxy("miles", PASSWORD, "203.0.113.7")).statusCode).toBe(429);
  // Another client behind the same proxy, and the proxy's own address, are not held back.
  expect((await fromProxy("miles", PASSWORD, "203.0.113.8")).statusCode).toBe(204);
  expect((await login(app, "miles", PASSWORD, { remoteAddress: "127.0.0.1" })).statusCode).toBe(204);
  // From anywhere else X-Forwarded-For is ignored: the connecting address is counted.
  expect((await login(app, "miles", PASSWORD, { remoteAddress: "10.3.0.1", forwardedFor: "203.0.113.7" })).statusCode).toBe(204);
});
