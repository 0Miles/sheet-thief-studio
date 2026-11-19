// Migrating from nothing, in a database of this file's own: the other files use the tables of the
// tests' database, migrated once for the run (tests/globalSetup.ts), and this one never touches
// them. Not a schema of its own: Sequelize looks for the table of the migrations in `public`.
import type { Sequelize } from "sequelize";
import { afterAll, beforeAll, expect, test } from "vitest";

import { connectDatabase } from "../src/db/database";
import { migrate } from "../src/db/migrate";
import * as manualVersions from "../src/db/migrations/0006-manual-versions";
import * as recognitions from "../src/db/migrations/0007-recognitions";
import { TEST_DATABASE_URL } from "./support";

const url = new URL(TEST_DATABASE_URL);
const DATABASE = `${url.pathname.slice(1)}_migrations`;
url.pathname = `/${DATABASE}`;

/** Drop this file's database if a run left it, and make it again, empty, when asked. */
async function dropDatabase({ andCreate }: { andCreate: boolean }): Promise<void> {
  const tests = connectDatabase(TEST_DATABASE_URL);
  try {
    await tests.query(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
    if (andCreate) await tests.query(`CREATE DATABASE "${DATABASE}"`);
  } finally {
    await tests.close();
  }
}

let sequelize: Sequelize;

beforeAll(async () => {
  await dropDatabase({ andCreate: true });
  sequelize = connectDatabase(url.toString());
});

afterAll(async () => {
  await sequelize.close();
  await dropDatabase({ andCreate: false });
});

async function columns(table: string): Promise<string[]> {
  const [rows] = await sequelize.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = :table ORDER BY column_name",
    { replacements: { table } },
  );
  return (rows as { column_name: string }[]).map((row) => row.column_name);
}

test("migrating an empty database creates the tables, and migrating again changes nothing", async () => {
  // All of them, from the first and in order: none was recorded in this database.
  expect(await migrate(sequelize)).toEqual(["0001-accounts", "0002-scores", "0003-link-tokens", "0004-phrases", "0005-versions", "0006-manual-versions", "0007-recognitions"]);
  const expected = {
    accounts: ["created_at", "disabled_at", "display_name", "id", "is_admin", "must_change_password", "updated_at", "username"],
    identities: ["account_id", "created_at", "id", "provider", "secret_hash", "subject"],
    scores: ["artist", "created_at", "deleted_at", "doc_state", "id", "link_token", "schema_version", "title", "updated_at"],
    score_members: ["account_id", "added_at", "role", "score_id"],
    phrases: ["bar_count", "content", "created_at", "id", "kind", "name", "owner_id", "revision", "staff_count", "string_count", "updated_at"],
    recognitions: ["account_id", "created_at", "error", "finished_at", "fragment", "id", "page_count", "report", "status"],
    recognition_images: ["data", "mime", "page", "recognition_id"],
  };
  const tables = async () => Object.fromEntries(await Promise.all(Object.keys(expected).map(async (table) => [table, await columns(table)])));
  expect(await tables()).toEqual(expected);

  expect(await migrate(sequelize)).toEqual([]);
  expect(await tables()).toEqual(expected);
});

test("0006 allows a member's own version, and taken back it deletes them and refuses the reason again", async () => {
  await migrate(sequelize);
  const context = sequelize.getQueryInterface();
  const [[score]] = (await sequelize.query("INSERT INTO scores (title, doc_state, schema_version) VALUES ('t', '\\x00', 1) RETURNING id")) as [{ id: string }[], unknown];
  const insert = (reason: string) =>
    sequelize.query("INSERT INTO versions (score_id, schema_version, content, content_hash, byte_size, reason, name) VALUES (:score, 1, '\\x00', :hash, 1, :reason, 'n')", {
      replacements: { score: score!.id, hash: "0".repeat(64), reason },
    });
  const reasons = async () => ((await sequelize.query("SELECT reason FROM versions ORDER BY reason", { plain: false })) as [{ reason: string }[], unknown])[0].map((row) => row.reason);
  await insert("manual");
  await insert("interval");

  await manualVersions.down({ context });
  expect(await reasons()).toEqual(["interval"]);
  await expect(insert("manual")).rejects.toThrow(/versions_reason_check/);

  await manualVersions.up({ context });
  await insert("manual");
  expect(await reasons()).toEqual(["interval", "manual"]);
});

test("0007 makes the recognitions and their images, one running per account; taken back it drops both, and made again it holds the same", async () => {
  await migrate(sequelize);
  const context = sequelize.getQueryInterface();
  const tables = async () => ({ recognitions: await columns("recognitions"), recognition_images: await columns("recognition_images") });
  const made = await tables();
  const [[account]] = (await sequelize.query("INSERT INTO accounts (username, display_name) VALUES ('mig', 'm') RETURNING id")) as [{ id: string }[], unknown];
  const start = () => sequelize.query("INSERT INTO recognitions (account_id, status, page_count) VALUES (:account, 'running', 1) RETURNING id", { replacements: { account: account!.id } });
  const [[recognition]] = (await start()) as [{ id: string }[], unknown];
  await sequelize.query("INSERT INTO recognition_images (recognition_id, page, mime, data) VALUES (:id, 1, 'image/png', '\\x00')", { replacements: { id: recognition!.id } });
  await expect(start()).rejects.toMatchObject({ parent: { constraint: "recognitions_one_running_per_account" } });

  await recognitions.down({ context });
  expect(await tables()).toEqual({ recognitions: [], recognition_images: [] });
  // The tables before it are left as they were.
  expect(await columns("versions")).not.toEqual([]);

  await recognitions.up({ context });
  expect(await tables()).toEqual(made);
  await start();
  await expect(start()).rejects.toMatchObject({ parent: { constraint: "recognitions_one_running_per_account" } });
  // An account deleted takes its recognitions with it.
  await sequelize.query("DELETE FROM accounts WHERE id = :account", { replacements: { account: account!.id } });
  expect(await sequelize.query("SELECT 1 FROM recognitions", { plain: false }).then(([rows]) => rows)).toEqual([]);
});
