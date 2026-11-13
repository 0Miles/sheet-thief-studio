import { Redis } from "ioredis";

import { buildApp } from "./app";
import { readConfig } from "./config";
import { connectDatabase } from "./db/database";

const config = readConfig();
const sequelize = connectDatabase(config.databaseUrl);
const redis = new Redis(config.redisUrl);
const app = buildApp({ config, redis });
app.addHook("onClose", async () => {
  await Promise.all([sequelize.close(), redis.quit()]);
});

sequelize
  .authenticate()
  .then(() => app.listen({ port: config.port, host: config.host }))
  .catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });
