// Once per run of the server's tests, before any file: the run takes a slot of its own, so that
// runs at once on one machine (two worktrees, say) never touch each other's data. The slot gives
// the run a database (`studio_test_run<slot>`, made from nothing and migrated here, dropped at
// the end) and a Redis database (index `<slot>`). Each file then only empties its tables
// (`freshDatabase`), which stays fast on a busy machine; tests/migrations.test.ts migrates a
// database of its own. `TEST_DATABASE_URL` or `TEST_REDIS_URL`, when set, is used as it is: that
// database is rebuilt in place.
//
// A slot is an advisory lock of Postgres, taken in a transaction this process keeps open until
// the run ends: a run that dies lets it go with its connection, and the next run in that slot
// drops the database it left.
import type { Sequelize, Transaction } from "sequelize";

import { connectDatabase } from "../src/db/database";
import { rebuiltDatabase } from "./support";

/** The database every run connects to first, to take a slot and make its own database. */
const SERVER_URL = "postgres://studio:studio@localhost:5438/studio_test";
/** Redis database indexes free for runs: 0 is development's, 1 the old default, 2 the end-to-end tests'. */
const SLOTS = Array.from({ length: 13 }, (_, i) => i + 3);
const REDIS_URL = "redis://localhost:6388";

export async function setup(): Promise<() => Promise<void>> {
  const { TEST_DATABASE_URL, TEST_REDIS_URL } = process.env;
  const held = TEST_DATABASE_URL && TEST_REDIS_URL ? undefined : await takeSlot();
  const ownDatabase = held && !TEST_DATABASE_URL ? `studio_test_run${held.slot}` : undefined;
  try {
    if (ownDatabase) {
      await held!.server.query(`DROP DATABASE IF EXISTS "${ownDatabase}" WITH (FORCE)`);
      await held!.server.query(`CREATE DATABASE "${ownDatabase}"`);
      const url = new URL(SERVER_URL);
      url.pathname = `/${ownDatabase}`;
      process.env.TEST_DATABASE_URL = url.toString();
    }
    if (held) process.env.TEST_REDIS_URL ??= `${REDIS_URL}/${held.slot}`;

    const sequelize = await rebuiltDatabase(process.env.TEST_DATABASE_URL!);
    await sequelize.close();
  } catch (error) {
    await held?.release();
    throw error;
  }

  return async () => {
    if (!held) return;
    try {
      if (ownDatabase) await held.server.query(`DROP DATABASE IF EXISTS "${ownDatabase}" WITH (FORCE)`);
    } finally {
      await held.release();
    }
  };
}

interface HeldSlot {
  slot: number;
  /** The connections to `SERVER_URL`, one of them in the transaction that holds the slot. */
  server: Sequelize;
  release(): Promise<void>;
}

/** The first slot no other run holds, held from now on until `release`. */
async function takeSlot(): Promise<HeldSlot> {
  const server = connectDatabase(SERVER_URL);
  let transaction: Transaction | undefined;
  const release = async () => {
    try {
      await transaction?.commit(); // lets the slot go
    } finally {
      await server.close();
    }
  };
  try {
    transaction = await server.transaction();
    for (const slot of SLOTS) {
      const [rows] = await server.query("SELECT pg_try_advisory_xact_lock(hashtext('studio-test-run'), :slot) AS taken", { replacements: { slot }, transaction });
      if ((rows as { taken: boolean }[])[0]!.taken) return { slot, server, release };
    }
    throw new Error(`all ${SLOTS.length} slots of the server's tests are held by other runs`);
  } catch (error) {
    await release();
    throw error;
  }
}
