// What the server's tests share: the real Postgres and Redis of compose.dev.yaml (CI starts
// service containers on the same ports), in databases that belong to the tests only.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import type { Sequelize } from "sequelize";

import { buildApp } from "../src/app";
import { type Config, readConfig } from "../src/config";
import { connectDatabase } from "../src/db/database";
import { migrate } from "../src/db/migrate";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://studio:studio@localhost:5438/studio_test";
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6388/1";

/** The origin the test app is published under; requests that change something send it. */
export const ORIGIN = "http://studio.test";

/** Drop every table of the test database, migrations included. */
export async function emptyDatabase(sequelize: Sequelize): Promise<void> {
  await sequelize.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}

/** A connection to an empty, migrated test database. */
export async function freshDatabase(): Promise<Sequelize> {
  const sequelize = connectDatabase(TEST_DATABASE_URL);
  await emptyDatabase(sequelize);
  await migrate(sequelize);
  return sequelize;
}

/** A connection to the emptied test Redis database. */
export async function freshRedis(): Promise<Redis> {
  const redis = new Redis(TEST_REDIS_URL);
  await redis.flushdb();
  return redis;
}

export function testConfig(env: NodeJS.ProcessEnv = {}): Config {
  return readConfig({ NODE_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, REDIS_URL: TEST_REDIS_URL, PUBLIC_ORIGIN: ORIGIN, ...env });
}

export { buildApp };

/** Run the CLI as the `cli` script does, with `input` piped to its stdin; returns its exit code and output. */
export function cli(args: string[], input = ""): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "src/cliMain.ts", ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  });
  const out: string[] = [];
  const err: string[] = [];
  child.stdout.on("data", (chunk) => out.push(String(chunk)));
  child.stderr.on("data", (chunk) => err.push(String(chunk)));
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout: out.join(""), stderr: err.join("") }));
  });
}

/** Log in as the web app does: a JSON body, from our own origin. */
export function login(app: FastifyInstance, username: string, password: string, options: { remoteAddress?: string; cookies?: Record<string, string> } = {}) {
  return app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: ORIGIN }, payload: { username, password }, ...options });
}

/** The session cookie a response sets, by its name in the test config. */
export function sessionCookie(response: { cookies: Array<{ name: string; value: string }> }, name = "__Host-studio_session") {
  return response.cookies.find((cookie) => cookie.name === name);
}

/** Who the session with this id belongs to, as `GET /api/me` answers. */
export function whoAmI(app: FastifyInstance, sessionId: string, name = "__Host-studio_session") {
  return app.inject({ method: "GET", url: "/api/me", cookies: { [name]: sessionId } });
}
