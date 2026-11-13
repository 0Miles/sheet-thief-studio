// The login rate limit (docs/spec/security.md, section 4): per username and per IP, each at most
// 10 failed logins in a 15-minute window.
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { buildApp, cli, freshDatabase, freshRedis, login, testConfig } from "./support";

const PASSWORD = "the admin's own password";

let sequelize: Sequelize;
let redis: Redis;
let app: FastifyInstance;

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  app = buildApp({ config: testConfig(), redis, logger: false });
  expect((await cli(["create-admin", "miles", "Miles"], `${PASSWORD}\n`)).code).toBe(0);
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
