// Once per run of the server's tests, before any file: the tests' database rebuilt from nothing
// and migrated. Each file then only empties its tables (`freshDatabase`), which stays fast on a
// busy machine; tests/migrations.test.ts migrates a schema of its own.
import { rebuiltDatabase, TEST_DATABASE_URL } from "./support";

export async function setup(): Promise<void> {
  const sequelize = await rebuiltDatabase(TEST_DATABASE_URL);
  await sequelize.close();
}
