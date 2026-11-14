// A score for an end-to-end test, written straight into the end-to-end database while the
// server runs (apps/web/e2e/pages.ts, `seedScore`): its Owner, its other members, how many bars
// it starts with and the parts it has besides the first, or its whole content (the measure
// suite's scores), given as JSON on stdin; prints its id.
// Members are added here until the pages that add them exist (#13). The score is new, so no
// server holds it in memory yet. It refuses any database whose name does not end in `_e2e`.
import { text } from "node:stream/consumers";

import { createScoreRequest, type Role } from "@studio/contracts";
import { addPart, type PartKind, SCHEMA_VERSION } from "@studio/score-model";
import * as Y from "yjs";

import { connectDatabase } from "../src/db/database";
import { Account, Score, ScoreMember } from "../src/db/models";
import { startContent } from "../src/scores";
import { e2eDatabaseUrl } from "./support";

const DATABASE_URL = e2eDatabaseUrl("scoreE2e");

interface ScoreFixture {
  title: string;
  /** Account names. */
  owner: string;
  members?: { username: string; role: Exclude<Role, "owner"> }[];
  bars?: number;
  /** Parts after the first one every new score has. */
  parts?: { name: string; kind: PartKind }[];
  /** The whole content instead, as a Yjs update in base64: `bars` and `parts` are then left out. */
  state?: string;
}

const fixture = JSON.parse(await text(process.stdin)) as ScoreFixture;
const sequelize = connectDatabase(DATABASE_URL);

const doc = new Y.Doc();
if (fixture.state !== undefined) {
  Y.applyUpdate(doc, Buffer.from(fixture.state, "base64"));
} else {
  startContent(doc, createScoreRequest.parse({ title: fixture.title }), fixture.bars);
  for (const part of fixture.parts ?? []) addPart(doc, part);
}
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
