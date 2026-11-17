// Prepares the end-to-end tests' database and Redis (apps/web/e2e/global-setup.ts): empties both,
// migrates, and creates the accounts given as JSON on stdin. It refuses any database whose name
// does not end in `_e2e`, so that it cannot empty a real one.
import { text } from "node:stream/consumers";

import { createAccount, type NewAccount } from "../src/accounts";
import { e2eDatabaseUrl, freshDatabase, freshRedis } from "./support";

const DATABASE_URL = e2eDatabaseUrl("seedE2e");
const { REDIS_URL } = process.env;
if (!REDIS_URL) throw new Error("seedE2e: REDIS_URL must be set");

const accounts = JSON.parse(await text(process.stdin)) as NewAccount[];

const sequelize = await freshDatabase(DATABASE_URL);
for (const account of accounts) await createAccount(account);
await sequelize.close();

const redis = await freshRedis(REDIS_URL);
await redis.quit();
