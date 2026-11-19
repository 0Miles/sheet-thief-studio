import type { Sequelize } from "sequelize";
import { afterAll, beforeAll, expect, test } from "vitest";

import { checkCredentials } from "../src/accounts";
import { Account, Identity } from "../src/db/models";
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
  expect((await cli(sequelize, ["create-admin", "ren", "Ren"], "ren's first password\n")).code).toBe(0);
  const invalid = await cli(sequelize, ["create-admin", "Not Valid", "Name"], "a good enough password\n");
  const taken = await cli(sequelize, ["create-admin", "ren", "Someone Else"], "another password here\n");
  expect([invalid.code, taken.code]).toEqual([1, 1]);
  expect(invalid.stderr).toContain("帳號名稱");
  expect(taken.stderr).toContain("ren");
  expect(await checkCredentials("ren", "another password here")).toBeNull();
  expect(await checkCredentials("ren", "ren's first password")).not.toBeNull();
});

test("create-admin takes no password as an argument", async () => {
  const { code, stderr } = await cli(sequelize, ["create-admin", "ana", "Ana", "a password in the shell history"]);
  expect(code).toBe(2);
  expect(stderr).toContain("create-admin");
  expect(await checkCredentials("ana", "a password in the shell history")).toBeNull();
});

test("the CLI runs on the connection it is given, leaves the models bound to it and leaves it open", async () => {
  expect((await cli(sequelize, ["create-admin", "kai", "Kai"], "kai's own password\n")).code).toBe(0);
  expect(Account.sequelize).toBe(sequelize);
  const [rows] = await sequelize.query("SELECT 1 AS open");
  expect(rows).toEqual([{ open: 1 }]);
  expect(await checkCredentials("kai", "kai's own password")).not.toBeNull();
});

test("migrate on a migrated database runs nothing", async () => {
  const { code, stdout } = await cli(sequelize, ["migrate"]);
  expect(code).toBe(0);
  expect(stdout).toContain("已是最新");
});

test("bind-discord binds a Discord id to an account, once; refuses what is no Discord id and an unknown account", async () => {
  expect((await cli(sequelize, ["create-admin", "bound-admin", "綁定的管理者"], "a password typed once\n")).code).toBe(0);
  const id = (await Account.findOne({ where: { username: "bound-admin" } }))!.id;

  const bound = await cli(sequelize, ["bind-discord", "Bound-Admin", "456789012345678901"]);
  expect([bound.code, bound.stdout]).toEqual([0, "已把 Discord ID 456789012345678901 綁定到 bound-admin。\n"]);
  expect(await Identity.findOne({ where: { provider: "karyl-chan", subject: "456789012345678901" } })).toMatchObject({ accountId: id });

  const again = await cli(sequelize, ["bind-discord", "bound-admin", "456789012345678902"]);
  const notAnId = await cli(sequelize, ["bind-discord", "bound-admin", "4567"]);
  const nobody = await cli(sequelize, ["bind-discord", "nobody-here", "456789012345678903"]);
  expect([again.code, notAnId.code, nobody.code]).toEqual([1, 1, 1]);
  expect(notAnId.stderr).toContain("17–20 位數字");
  expect(nobody.stderr).toContain("沒有帳號 nobody-here");
  expect(await Identity.count({ where: { provider: "karyl-chan", accountId: id } })).toBe(1);
});
