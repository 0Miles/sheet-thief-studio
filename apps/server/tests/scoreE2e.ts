// A score for an end-to-end test, written straight into the end-to-end database while the
// server runs (apps/web/e2e/pages.ts, `seedScore`): its Owner, its other members and how many
// bars it starts with, given as JSON on stdin; prints its id. Members are added here until the
// pages that add them exist (#13). The score is new, so no server holds it in memory yet. It
// refuses any database whose name does not end in `_e2e`.
import { text } from "node:stream/consumers";

import type { Role } from "@studio/contracts";
import { SCHEMA_VERSION } from "@studio/score-model";
import * as Y from "yjs";

import { connectDatabase } from "../src/db/database";
import { Account, Score, ScoreMember } from "../src/db/models";
import { startContent } from "../src/scores";

const { DATABASE_URL, NODE_ENV } = process.env;
if (!DATABASE_URL || NODE_ENV === "production" || !new URL(DATABASE_URL).pathname.endsWith("_e2e")) {
  throw new Error("scoreE2e: DATABASE_URL must name a database ending in _e2e");
}

interface ScoreFixture {
  title: string;
  /** Account names. */
  owner: string;
  members?: { username: string; role: Exclude<Role, "owner"> }[];
  bars?: number;
}

const fixture = JSON.parse(await text(process.stdin)) as ScoreFixture;
const sequelize = connectDatabase(DATABASE_URL);

const doc = new Y.Doc();
startContent(doc, fixture.title, fixture.bars);
const id = await sequelize.transaction(async (transaction) => {
  const score = await Score.create({ title: fixture.title, docState: Buffer.from(Y.encodeStateAsUpdate(doc)), schemaVersion: SCHEMA_VERSION }, { transaction });
  const members = [{ username: fixture.owner, role: "owner" as Role }, ...(fixture.members ?? [])];
  for (const { username, role } of members) {
    const account = await Account.findOne({ where: { username }, transaction });
    if (account === null) throw new Error(`scoreE2e: no account ${username}`);
    await ScoreMember.create({ scoreId: score.id, accountId: account.id, role }, { transaction });
  }
  return score.id;
});
await sequelize.close();
process.stdout.write(JSON.stringify({ id }));
