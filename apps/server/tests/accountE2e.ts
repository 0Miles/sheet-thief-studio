// An account for an end-to-end test, written straight into the end-to-end database while the
// server runs (apps/web/e2e/pages.ts, `seedAccount`), given as JSON on stdin: one a test uses up,
// such as an account whose temporary password it changes, made anew for every run of that test
// until /admin makes accounts. It refuses any database whose name does not end in `_e2e`.
import { text } from "node:stream/consumers";

import { createAccount, type NewAccount } from "../src/accounts";
import { connectDatabase } from "../src/db/database";
import { e2eDatabaseUrl } from "./support";

const sequelize = connectDatabase(e2eDatabaseUrl("accountE2e"));
await createAccount(JSON.parse(await text(process.stdin)) as NewAccount);
await sequelize.close();
