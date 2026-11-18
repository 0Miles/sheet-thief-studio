import { Redis } from "ioredis";

import { buildApp } from "./app";
import { readConfig } from "./config";
import { connectDatabase } from "./db/database";
import { karylPlugin } from "./karylPlugin";

const config = readConfig();
const sequelize = connectDatabase(config.databaseUrl);
const redis = new Redis(config.redisUrl);
// The plugin of the karyl-chan bot, when its setup secret is set (docs/spec/karyl-login.md, section 3).
const karyl = config.karyl === null ? undefined : karylPlugin(config.karyl, config.publicOrigin);
const app = buildApp({ config, redis, karyl });
// Never meant for a server people use: say so where whoever started it will look.
if (!config.sessionCookie.secure) {
  app.log.warn(`INSECURE_COOKIES=1: the session cookie is "${config.sessionCookie.name}", without the __Host- prefix and Secure; for http development and tests only`);
}
app.addHook("onClose", async () => {
  await karyl?.stop();
  await Promise.all([sequelize.close(), redis.quit()]);
});

sequelize
  .authenticate()
  .then(() => app.listen({ port: config.port, host: config.host }))
  // Registered once this server answers: the bot dispatches here as soon as it accepts the plugin.
  .then(() => karyl?.start())
  .catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });
