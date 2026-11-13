// Schema migrations with umzug, recorded in the table `migrations`. Each migration is listed
// here by hand, in order: running them again skips the ones already recorded.
import type { Sequelize } from "sequelize";
import { SequelizeStorage, Umzug } from "umzug";

import * as accounts from "./migrations/0001-accounts";

/** Bring the database up to the latest schema; returns the names of the migrations it ran. */
export async function migrate(sequelize: Sequelize): Promise<string[]> {
  const ran = await new Umzug({
    migrations: [{ name: "0001-accounts", ...accounts }],
    context: sequelize.getQueryInterface(),
    storage: new SequelizeStorage({ sequelize, tableName: "migrations" }),
    logger: undefined,
  }).up();
  return ran.map((migration) => migration.name);
}
