// What the server's tests share: the real Postgres and Redis of compose.dev.yaml (CI starts
// service containers on the same ports), in databases that belong to the tests only.
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
