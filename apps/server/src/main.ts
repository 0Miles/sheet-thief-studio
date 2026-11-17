import { Redis } from "ioredis";

import { buildApp } from "./app";
import { readConfig } from "./config";
import { connectDatabase } from "./db/database";

const config = readConfig();
const sequelize = connectDatabase(config.databaseUrl);
const redis = new Redis(config.redisUrl);
const app = buildApp({ config, redis });
// Never meant for a server people use: say so where whoever started it will look.
if (!config.sessionCookie.secure) {
  app.log.warn(`INSECURE_COOKIES=1: the session cookie is "${config.sessionCookie.name}", without the __Host- prefix and Secure; for http development and tests only`);
}
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
