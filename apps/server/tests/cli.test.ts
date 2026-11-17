import type { Sequelize } from "sequelize";
import { afterAll, beforeAll, expect, test } from "vitest";

import { checkCredentials } from "../src/accounts";
import { cli, freshDatabase } from "./support";

let sequelize: Sequelize;

beforeAll(async () => {
  sequelize = await freshDatabase();
});

afterAll(async () => {
  await sequelize.close();
});

test("create-admin reads the password from stdin and makes an admin who need not change it", async () => {
  const { code } = await cli(["create-admin", "miles", "Miles"], "a password typed once\n");
  expect(code).toBe(0);
  const account = await checkCredentials("miles", "a password typed once");
  expect(account?.toJSON()).toMatchObject({ username: "miles", displayName: "Miles", isAdmin: true, mustChangePassword: false, disabledAt: null });
});

// Each run of the CLI starts a process: the refusals of one rule run side by side.
test("create-admin refuses a password shorter than 10 or longer than 256 characters", async () => {
  const refusals = await Promise.all([
    cli(["create-admin", "short", "Short"], "nine char\n"),
    cli(["create-admin", "long", "Long"], `${"x".repeat(257)}\n`),
  ]);
  expect(refusals.map((refusal) => refusal.code)).toEqual([1, 1]);
  expect(await checkCredentials("short", "nine char")).toBeNull();
  expect(await checkCredentials("long", "x".repeat(257))).toBeNull();
});

test("create-admin refuses a username outside the rules and one that is taken", async () => {
  const refusals = await Promise.all([
    cli(["create-admin", "Not Valid", "Name"], "a good enough password\n"),
    cli(["create-admin", "miles", "Someone Else"], "another password here\n"),
  ]);
  expect(refusals.map((refusal) => refusal.code)).toEqual([1, 1]);
  expect(refusals[1]!.stderr).toContain("miles");
  expect(await checkCredentials("miles", "another password here")).toBeNull();
});

test("create-admin takes no password as an argument", async () => {
  const { code, stderr } = await cli(["create-admin", "ana", "Ana", "a password in the shell history"]);
  expect(code).toBe(2);
  expect(stderr).toContain("create-admin");
  expect(await checkCredentials("ana", "a password in the shell history")).toBeNull();
});

test("migrate on a migrated database runs nothing", async () => {
  const { code, stdout } = await cli(["migrate"]);
  expect(code).toBe(0);
  expect(stdout).toContain("已是最新");
});
