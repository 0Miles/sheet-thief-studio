import type { Sequelize } from "sequelize";
import { afterAll, beforeAll, expect, test } from "vitest";

import { checkCredentials } from "../src/accounts";
import { cli, cliProcess, freshDatabase } from "./support";

let sequelize: Sequelize;

beforeAll(async () => {
  sequelize = await freshDatabase();
});

afterAll(async () => {
  await sequelize.close();
});

// The one test of the command as the server runs it: a process of its own, which connects to the
// database DATABASE_URL names and reads the password piped to it. The other tests run the same
// command in this process, on this file's connection: a process started for each of them takes
// seconds on a busy machine (#116).
test("create-admin reads the password from stdin and makes an admin who need not change it", async () => {
  const { code } = await cliProcess(["create-admin", "miles", "Miles"], "a password typed once\n");
  expect(code).toBe(0);
  const account = await checkCredentials("miles", "a password typed once");
  expect(account?.toJSON()).toMatchObject({ username: "miles", displayName: "Miles", isAdmin: true, mustChangePassword: false, disabledAt: null });
});

test("create-admin refuses a password shorter than 10 or longer than 256 characters", async () => {
  const short = await cli(sequelize, ["create-admin", "short", "Short"], "nine char\n");
  const long = await cli(sequelize, ["create-admin", "long", "Long"], `${"x".repeat(257)}\n`);
  expect([short.code, long.code]).toEqual([1, 1]);
  expect(short.stderr).toContain("密碼長度");
  expect(long.stderr).toContain("密碼長度");
  expect(await checkCredentials("short", "nine char")).toBeNull();
  expect(await checkCredentials("long", "x".repeat(257))).toBeNull();
});

test("create-admin refuses a username outside the rules and one that is taken", async () => {
  const invalid = await cli(sequelize, ["create-admin", "Not Valid", "Name"], "a good enough password\n");
  const taken = await cli(sequelize, ["create-admin", "miles", "Someone Else"], "another password here\n");
  expect([invalid.code, taken.code]).toEqual([1, 1]);
  expect(invalid.stderr).toContain("帳號名稱");
  expect(taken.stderr).toContain("miles");
  expect(await checkCredentials("miles", "another password here")).toBeNull();
});

test("create-admin takes no password as an argument", async () => {
  const { code, stderr } = await cli(sequelize, ["create-admin", "ana", "Ana", "a password in the shell history"]);
  expect(code).toBe(2);
  expect(stderr).toContain("create-admin");
  expect(await checkCredentials("ana", "a password in the shell history")).toBeNull();
});

test("a connection given to the CLI is neither closed nor bound again", async () => {
  expect((await cli(sequelize, ["create-admin", "kai", "Kai"], "kai's own password\n")).code).toBe(0);
  const [rows] = await sequelize.query("SELECT 1 AS open");
  expect(rows).toEqual([{ open: 1 }]);
  expect(await checkCredentials("kai", "kai's own password")).not.toBeNull();
});

test("migrate on a migrated database runs nothing", async () => {
  const { code, stdout } = await cli(sequelize, ["migrate"]);
  expect(code).toBe(0);
  expect(stdout).toContain("已是最新");
});
