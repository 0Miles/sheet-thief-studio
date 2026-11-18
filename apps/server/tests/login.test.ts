// Logging in and out, the session cookie, the Origin check and the sliding session
// (docs/spec/security.md, sections 1 and 2; docs/spec/routes.md, 3.1).
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { buildApp } from "../src/app";
import { Account } from "../src/db/models";
import { cli, COOKIE, freshDatabase, freshRedis, login, ORIGIN, sessionCookie, testConfig, whoAmI } from "./support";

const PASSWORD = "the admin's own password";
const THIRTY_DAYS = 30 * 24 * 60 * 60;

let sequelize: Sequelize;
let redis: Redis;
let app: FastifyInstance;

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  app = buildApp({ config: testConfig(), redis, logger: false });
  expect((await cli(sequelize, ["create-admin", "miles", "Miles"], `${PASSWORD}\n`)).code).toBe(0);
});

beforeEach(async () => {
  await redis.flushdb();
  await Account.update({ disabledAt: null }, { where: { username: "miles" } });
});

afterAll(async () => {
  await app.close();
  await redis.quit();
  await sequelize.close();
});

async function sessionOf(username: string, password: string): Promise<string> {
  const response = await login(app, username, password);
  expect(response.statusCode).toBe(204);
  return sessionCookie(response)!.value;
}

test("an admin made by the CLI logs in and is told who they are", async () => {
  const response = await whoAmI(app, await sessionOf("miles", PASSWORD));
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ accountId: expect.any(String), username: "miles", displayName: "Miles", isAdmin: true, mustChangePassword: false });
});

test("a wrong password, an unknown username and a disabled account all get the same answer", async () => {
  const wrongPassword = await login(app, "miles", "not the password");
  const unknown = await login(app, "nobody", PASSWORD);
  await Account.update({ disabledAt: new Date() }, { where: { username: "miles" } });
  const disabled = await login(app, "miles", PASSWORD);
  for (const response of [wrongPassword, unknown, disabled]) {
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ code: "invalid_credentials" });
    expect(response.headers["set-cookie"]).toBeUndefined();
  }
});

test("a disabled account's session no longer works", async () => {
  const session = await sessionOf("miles", PASSWORD);
  await Account.update({ disabledAt: new Date() }, { where: { username: "miles" } });
  expect((await whoAmI(app, session)).statusCode).toBe(401);
});

test("the session cookie is __Host- prefixed, HttpOnly, Secure, SameSite=Lax, on the whole site and kept 30 days", async () => {
  const response = await login(app, "miles", PASSWORD);
  expect(response.cookies).toEqual([
    { name: COOKIE, value: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), path: "/", httpOnly: true, secure: true, sameSite: "Lax", maxAge: THIRTY_DAYS },
  ]);
});

test("a request to the API that may change something must come from our origin", async () => {
  const send = (method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, origin?: string) =>
    app.inject({ method, url, headers: origin ? { origin } : {}, payload: { username: "miles", password: PASSWORD } });
  for (const origin of [undefined, "https://elsewhere.example", "null", `${ORIGIN}.elsewhere.example`]) {
    const response = await send("POST", "/api/auth/login", origin);
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ code: "bad_origin" });
    expect(response.headers["set-cookie"]).toBeUndefined();
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
    expect((await send(method, "/api/any/path")).statusCode).toBe(403);
  }
  // The router decodes the path before matching: an encoded /api is still checked.
  for (const url of ["/api/auth/logout", "/%61pi/auth/login", "/%61pi/auth/logout"]) {
    expect((await send("POST", url)).statusCode).toBe(403);
  }
  // Reading needs no Origin.
  expect((await app.inject({ method: "GET", url: "/api/me" })).json()).toEqual({ code: "unauthenticated" });
});

test("every use of the session moves its expiry 30 days ahead", async () => {
  const session = await sessionOf("miles", PASSWORD);
  await redis.expire(`session:${session}`, 60);
  const response = await whoAmI(app, session);
  expect(response.statusCode).toBe(200);
  expect(await redis.ttl(`session:${session}`)).toBeGreaterThan(THIRTY_DAYS - 60);
  // The browser keeps the cookie as long.
  expect(sessionCookie(response)).toMatchObject({ value: session, maxAge: THIRTY_DAYS });
});

test("logging out ends the session and clears the cookie", async () => {
  const session = await sessionOf("miles", PASSWORD);
  const other = await sessionOf("miles", PASSWORD);
  const response = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin: ORIGIN }, cookies: { [COOKIE]: session } });
  expect(response.statusCode).toBe(204);
  expect(sessionCookie(response)).toMatchObject({ value: "", path: "/", secure: true, maxAge: 0 });
  expect((await whoAmI(app, session)).statusCode).toBe(401);
  // Only that session: the account's other device stays logged in.
  expect((await whoAmI(app, other)).statusCode).toBe(200);
});

test("logging in again gives a new session and ends the one the browser had", async () => {
  const before = await sessionOf("miles", PASSWORD);
  const response = await login(app, "miles", PASSWORD, { cookies: { [COOKIE]: before } });
  const after = sessionCookie(response)!.value;
  expect(after).not.toBe(before);
  expect((await whoAmI(app, before)).statusCode).toBe(401);
  expect((await whoAmI(app, after)).statusCode).toBe(200);
});

test("a session id that does not exist is refused, and the browser told to forget it", async () => {
  const response = await whoAmI(app, "A".repeat(43));
  expect(response.statusCode).toBe(401);
  expect(response.json()).toEqual({ code: "unauthenticated" });
  expect(sessionCookie(response)).toMatchObject({ value: "", maxAge: 0 });
});

test("INSECURE_COOKIES=1 names the cookie studio_session and drops Secure, for http in development", async () => {
  const insecure = buildApp({ config: testConfig({ INSECURE_COOKIES: "1" }), redis, logger: false });
  const response = await login(insecure, "miles", PASSWORD);
  expect(response.cookies).toEqual([
    { name: "studio_session", value: expect.any(String), path: "/", httpOnly: true, sameSite: "Lax", maxAge: THIRTY_DAYS },
  ]);
  expect((await whoAmI(insecure, sessionCookie(response, "studio_session")!.value, "studio_session")).statusCode).toBe(200);
  await insecure.close();
});

test("in production INSECURE_COOKIES has no effect", async () => {
  const production = buildApp({ config: testConfig({ INSECURE_COOKIES: "1", NODE_ENV: "production" }), redis, logger: false });
  const response = await login(production, "miles", PASSWORD);
  expect(response.cookies).toEqual([expect.objectContaining({ name: COOKIE, secure: true })]);
  await production.close();
});
