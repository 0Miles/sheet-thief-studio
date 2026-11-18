// The one thing an admin may do to someone else's score (docs/spec/accounts.md, section 2): when
// its Owner is disabled, hand it over to a member who can log in; and nothing else, to nobody else.
import { ResetConnection } from "@hocuspocus/common";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";

import { createAccount, setDisabled } from "../src/accounts";
import { buildApp } from "../src/app";
import { Score, ScoreMember } from "../src/db/models";
import { apiCall, askTicket, closes, createMembers, createScore, freshDatabase, freshRedis, insync, listen, type OpenScore, openScore, sessionOf, socketClosed, testConfig, ticketFor, warmPool } from "./support";

const PASSWORD = "a password long enough";

let sequelize: Sequelize;
let redis: Redis;
let app: FastifyInstance;
let admin: string;
let opened: OpenScore[] = [];
/** Account ids by username. */
const ids: Record<string, string> = {};

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  await createAccount({ username: "the-admin", displayName: "管理者", password: PASSWORD, isAdmin: true, mustChangePassword: false });
  Object.assign(ids, await createMembers(["anna", "ben", "cara", "dan"], PASSWORD));
});

beforeEach(async () => {
  await redis.flushdb();
  // Every test starts with every account enabled and no score.
  for (const id of Object.values(ids)) await setDisabled(id, false);
  await Score.destroy({ where: {} });
  app = buildApp({ config: testConfig(), redis, logger: false });
  admin = await sessionOf(app, "the-admin", PASSWORD);
});

afterEach(async () => {
  for (const { provider } of opened) provider.destroy();
  opened = [];
  await app.close();
});

afterAll(async () => {
  await redis.quit();
  await sequelize.close();
});

const send = (method: "GET" | "POST", url: string, session: string, payload?: object) => apiCall(app, method, url, session, payload);

/** A score of Anna's with these other members, in this order; Anna is then disabled unless told otherwise. */
async function annasScore(members: Record<string, "editor" | "viewer">, { disabled = true, title = "停用者的團譜" } = {}): Promise<string> {
  const anna = await sessionOf(app, "anna", PASSWORD);
  const id = await createScore(app, anna, title);
  // Straight in the database: the Owner's lookups of usernames are limited.
  for (const [username, role] of Object.entries(members)) await ScoreMember.create({ scoreId: id, accountId: ids[username]!, role });
  if (disabled) await setDisabled(ids.anna!, true);
  return id;
}

async function roles(scoreId: string): Promise<Record<string, string>> {
  const members = await ScoreMember.findAll({ where: { scoreId } });
  const usernames = Object.fromEntries(Object.entries(ids).map(([username, id]) => [id, username]));
  return Object.fromEntries(members.map(({ accountId, role }) => [usernames[accountId], role]));
}

const transfer = (scoreId: string, accountId: string | undefined, session = admin) => send("POST", `/api/admin/scores/${scoreId}/transfer`, session, accountId === undefined ? {} : { accountId });

test("an admin hands a disabled Owner's score to a member who can log in: the member is its Owner, the Owner of before an Editor", async () => {
  const id = await annasScore({ ben: "viewer", cara: "editor" });

  const response = await transfer(id, ids.ben);

  expect(response.statusCode).toBe(204);
  expect(await roles(id)).toEqual({ anna: "editor", ben: "owner", cara: "editor" });
  // Ben now manages it, as the Owner.
  const bens = await sessionOf(app, "ben", PASSWORD);
  expect((await send("GET", `/api/scores/${id}`, bens)).json()).toMatchObject({ role: "owner", owner: { accountId: ids.ben } });
  expect((await send("POST", `/api/scores/${id}/members`, bens, { username: "dan" })).statusCode).toBe(201);
});

test("no transfer while the Owner can log in, to anyone who is no member, to a disabled member, or to the Owner; nothing changes", async () => {
  // A score of Ben's, who can log in, with Cara.
  const enabled = await createScore(app, await sessionOf(app, "ben", PASSWORD), "班的團譜");
  await ScoreMember.create({ scoreId: enabled, accountId: ids.cara!, role: "editor" });
  const id = await annasScore({ ben: "editor", cara: "viewer" });
  await setDisabled(ids.cara!, true);

  const answers = [
    // The Owner can log in: to an admin, there is no such score.
    [await transfer(enabled, ids.cara), 404, "not_found"],
    [await transfer(id, ids.dan), 404, "not_found"],
    [await transfer(id, "not-an-account"), 404, "not_found"],
    [await transfer(id, ids.cara), 400, "invalid_request"],
    [await transfer(id, ids.anna), 400, "invalid_request"],
    [await transfer(id, undefined), 400, "invalid_request"],
  ] as const;

  for (const [response, status, code] of answers) expect([response.statusCode, response.json()]).toMatchObject([status, { code }]);
  expect(await roles(enabled)).toEqual({ ben: "owner", cara: "editor" });
  expect(await roles(id)).toEqual({ anna: "owner", ben: "editor", cara: "viewer" });
});

test("a score that is deleted, missing or no id at all is answered 404, whatever the body, and is not listed", async () => {
  const deleted = await annasScore({ ben: "editor" });
  await Score.update({ deletedAt: new Date() }, { where: { id: deleted } });

  for (const id of [deleted, "00000000-0000-4000-8000-000000000000", "not-a-score"]) {
    for (const accountId of [ids.ben, undefined]) {
      const response = await transfer(id, accountId);
      expect([id, response.statusCode, response.json()]).toEqual([id, 404, { code: "not_found" }]);
    }
  }
  expect(await roles(deleted)).toEqual({ anna: "owner", ben: "editor" });
  expect((await send("GET", "/api/admin/orphaned-scores", admin)).json()).toEqual({ scores: [] });
});

test("anyone but an admin is answered 404 by the list and the transfer, the score's own members too, and nothing changes", async () => {
  const id = await annasScore({ ben: "editor", cara: "viewer" });
  for (const username of ["ben", "cara", "dan"]) {
    const session = await sessionOf(app, username, PASSWORD);
    for (const response of [await send("GET", "/api/admin/orphaned-scores", session), await transfer(id, ids[username], session), await transfer(id, ids.ben, session)]) {
      expect([username, response.statusCode, response.json()]).toEqual([username, 404, { code: "not_found" }]);
    }
  }
  expect((await app.inject({ method: "GET", url: "/api/admin/orphaned-scores" })).statusCode).toBe(401);
  expect(await roles(id)).toEqual({ anna: "owner", ben: "editor", cara: "viewer" });
});

test("the list shows each score of a disabled Owner: its title, its Owner and its members who can log in; no content, no other score", async () => {
  const first = await annasScore({ dan: "viewer", ben: "editor", cara: "viewer" }, { title: "B 曲", disabled: false });
  const second = await annasScore({}, { title: "A 曲" });
  await setDisabled(ids.dan!, true);
  // Ben's own, whose Owner can log in, is not listed.
  await createScore(app, await sessionOf(app, "ben", PASSWORD), "班的團譜");

  const response = await send("GET", "/api/admin/orphaned-scores", admin);

  expect(response.statusCode).toBe(200);
  const anna = { accountId: ids.anna, username: "anna", displayName: "anna 的名字" };
  expect(response.json()).toEqual({
    scores: [
      // With nobody to hand it to: listed, and it stays as it is.
      { id: second, title: "A 曲", owner: anna, members: [] },
      {
        id: first,
        title: "B 曲",
        owner: anna,
        members: [
          { accountId: ids.ben, username: "ben", displayName: "ben 的名字", role: "editor" },
          { accountId: ids.cara, username: "cara", displayName: "cara 的名字", role: "viewer" },
        ],
      },
    ],
  });
  expect((await transfer(second, ids.ben)).statusCode).toBe(404);
  expect(await roles(second)).toEqual({ anna: "owner" });

  // Handed over, it is no longer listed.
  expect((await transfer(first, ids.cara)).statusCode).toBe(204);
  expect((await send("GET", "/api/admin/orphaned-scores", admin)).json()).toEqual({ scores: [expect.objectContaining({ id: second })] });
});

test("a transfer closes the new Owner's connections to the score, which come back as the Owner's; the other members' stay", async () => {
  const url = await listen(app);
  const id = await annasScore({ ben: "viewer", cara: "editor" });
  const sessions = { ben: await sessionOf(app, "ben", PASSWORD), cara: await sessionOf(app, "cara", PASSWORD) };
  const open = async (session: string) => {
    const score = await openScore(url, id, () => ticketFor(app, id, session));
    opened.push(score);
    return score;
  };
  const ben = await open(sessions.ben);
  const caraClosed = closes(await open(sessions.cara));

  const closed = socketClosed(ben.provider);
  const back = insync(ben.provider);
  expect((await transfer(id, ids.ben)).statusCode).toBe(204);

  expect(await closed).toBe(ResetConnection.code);
  await back;
  expect((await askTicket(app, id, sessions.ben)).json()).toMatchObject({ role: "owner" });
  expect(caraClosed()).toBe(false);
});

test("transfers sent at once, and a member leaving as the score is handed to them, leave one Owner and answers that agree", async () => {
  // Which gets to the database first is not ours to choose: many scores, each raced once.
  const scores: string[] = [];
  for (let index = 0; index < 16; index += 1) scores.push(await annasScore({ ben: "editor", cara: "editor" }, { disabled: false }));
  await setDisabled(ids.anna!, true);
  const bens = await sessionOf(app, "ben", PASSWORD);
  await warmPool(sequelize);

  const answers = await Promise.all(
    scores.map(async (id, index) => {
      // Half of them handed to Ben and to Cara at once; the other half to Ben as he leaves.
      const race = index % 2;
      const [first, second] = await Promise.all(race === 0 ? [transfer(id, ids.ben), transfer(id, ids.cara)] : [transfer(id, ids.ben), send("POST", `/api/scores/${id}/leave`, bens)]);
      return { race, statuses: [first.statusCode, second.statusCode], roles: await roles(id) };
    }),
  );

  // As if one had come after the other: once Ben or Cara is the Owner, Anna is no disabled Owner
  // and the other transfer finds no such score; once Ben has left, there is no Ben to hand it to.
  const outcomes = [
    { race: 0, statuses: [204, 404], roles: { anna: "editor", ben: "owner", cara: "editor" } },
    { race: 0, statuses: [404, 204], roles: { anna: "editor", ben: "editor", cara: "owner" } },
    { race: 1, statuses: [204, 409], roles: { anna: "editor", ben: "owner", cara: "editor" } },
    { race: 1, statuses: [404, 204], roles: { anna: "owner", cara: "editor" } },
  ];
  for (const answer of answers) expect(outcomes).toContainEqual(answer);
});
