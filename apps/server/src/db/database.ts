// The server's Postgres: one Sequelize instance, with the models bound to it.
import { Sequelize } from "sequelize";

import { initModels } from "./models";

export function connectDatabase(url: string): Sequelize {
  const sequelize = new Sequelize(url, { dialect: "postgres", logging: false });
  initModels(sequelize);
  return sequelize;
}
