import type { Sequelize } from "sequelize";
import { afterAll, beforeAll, expect, test } from "vitest";

import { connectDatabase } from "../src/db/database";
import { migrate } from "../src/db/migrate";
import { emptyDatabase, TEST_DATABASE_URL } from "./support";

let sequelize: Sequelize;

beforeAll(async () => {
  sequelize = connectDatabase(TEST_DATABASE_URL);
  await emptyDatabase(sequelize);
});

afterAll(async () => {
  await sequelize.close();
});

async function columns(table: string): Promise<string[]> {
  const [rows] = await sequelize.query(
    "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = :table ORDER BY column_name",
    { replacements: { table } },
  );
  return (rows as { column_name: string }[]).map((row) => row.column_name);
}

test("migrating an empty database creates the accounts and identities tables, and migrating again changes nothing", async () => {
  await migrate(sequelize);
  const expected = {
    accounts: ["created_at", "disabled_at", "display_name", "id", "is_admin", "must_change_password", "updated_at", "username"],
    identities: ["account_id", "created_at", "id", "provider", "secret_hash", "subject"],
  };
  expect({ accounts: await columns("accounts"), identities: await columns("identities") }).toEqual(expected);

  await migrate(sequelize);
  expect({ accounts: await columns("accounts"), identities: await columns("identities") }).toEqual(expected);
});
