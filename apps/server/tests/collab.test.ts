// /collab: opening a score with a collab ticket, keeping its content in Postgres, and the server
// closing only the connections an event concerns (docs/spec/collab.md; docs/adr/0005).
import { randomUUID } from "node:crypto";

import { Forbidden } from "@hocuspocus/common";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Role } from "@studio/contracts";
import { docToJson, metaOf } from "@studio/score-model";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import * as Y from "yjs";

import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import { CollabTickets, TICKET_TTL_SECONDS } from "../src/collabTickets";
import { Score, ScoreMember } from "../src/db/models";
import { closes, COOKIE, createScore, freshDatabase, freshRedis, insync, listen, nextSyncStatus, type OpenScore, openScore, ORIGIN, sessionOf, socketClosed, testConfig, ticketFor, whoAmI } from "./support";

const PASSWORD = "a password long enough";

let sequelize: Sequelize;
let redis: Redis;
/** Apps and providers a test opened, closed after it whatever happens. */
let apps: FastifyInstance[] = [];
let opened: OpenScore[] = [];
let ben: string;

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  const account = (username: string) => createAccount({ username, displayName: username, password: PASSWORD, isAdmin: false, mustChangePassword: false });
  await account("anna");
  ben = (await account("ben")).id;
});

beforeEach(async () => {
  await redis.flushdb();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { provider } of opened) provider.destroy();
  for (const app of apps) await app.close();
  apps = [];
  opened = [];
});

afterAll(async () => {
  await redis.quit();
  await sequelize.close();
});

/** A new app on the test database, listening; returns it and the URL of its /collab. */
async function startApp(): Promise<{ app: FastifyInstance; url: string }> {
  const app = buildApp({ config: testConfig(), redis, logger: false });
  apps.push(app);
  return { app, url: await listen(app) };
}

async function open(app: FastifyInstance, url: string, scoreId: string, session: string): Promise<OpenScore> {
  const score = await openScore(url, scoreId, () => ticketFor(app, scoreId, session));
  opened.push(score);
  return score;
}

test("a score created through the API, then changed, comes back the same from a new app on the same database", async () => {
  const first = await startApp();
  const session = await sessionOf(first.app, "anna", PASSWORD);
  const id = await createScore(first.app, session, "測試團譜");

  const { provider, doc } = await open(first.app, first.url, id, session);
  const created = docToJson(doc);
  expect(created.title).toBe("測試團譜");
  expect(created.parts.map((part) => [part.name, part.kind, part.tuning])).toEqual([["吉他 1", "fretted", [64, 59, 55, 50, 45, 40]]]);
  expect(created.bars).toHaveLength(8);
  expect(created.bars.every((bar) => bar.timeSig.numerator === 4 && bar.timeSig.denominator === 4)).toBe(true);
  // A change a member makes is kept too, not only what the server made.
  const applied = nextSyncStatus(provider);
  metaOf(doc).set("title", "改過的標題");
  expect(await applied).toBe(true);
  const before = docToJson(doc);

  await first.app.close();
  const second = await startApp();
  const again = await open(second.app, second.url, id, session);
  expect(docToJson(again.doc)).toEqual(before);
});

test("an expired, used or other score's ticket, and a score that does not exist or is deleted, are refused without making a score", async () => {
  const { app, url } = await startApp();
  const session = await sessionOf(app, "anna", PASSWORD);
  const [mine, other, deleted] = [await createScore(app, session), await createScore(app, session), await createScore(app, session)];
  const scoresBefore = await Score.count();
  const refusal = (scoreId: string, ticket: string) => expect(openScore(url, scoreId, async () => ticket)).rejects.toThrow(/refused/);

  // A ticket lasts 60 seconds in Redis; one that has run out is gone.
  const expired = await ticketFor(app, mine, session);
  expect(await redis.ttl(`collab-ticket:${expired}`)).toBe(TICKET_TTL_SECONDS);
  await redis.pexpire(`collab-ticket:${expired}`, 1);
  await expect.poll(() => redis.exists(`collab-ticket:${expired}`)).toBe(0);
  await refusal(mine, expired);

  const used = await ticketFor(app, mine, session);
  opened.push(await openScore(url, mine, async () => used));
  await refusal(mine, used);

  await refusal(mine, await ticketFor(app, other, session));
  // Tickets as the API never gives them: for a score that does not exist.
  const accountId = (await whoAmI(app, session)).json().accountId as string;
  for (const nowhere of [randomUUID(), "not-a-score"]) {
    await refusal(nowhere, await new CollabTickets(redis).issue({ scoreId: nowhere, accountId, sessionId: session, role: "owner" }));
  }
  const beforeDeletion = await ticketFor(app, deleted, session);
  await Score.update({ deletedAt: new Date() }, { where: { id: deleted } });
  const deletedState = (await Score.findByPk(deleted))!.docState;
  await refusal(deleted, beforeDeletion);

  // No refused id was loaded, nothing was stored over the deleted score, no score was made.
  expect(app.collab.loadedScores()).toEqual([mine]);
  expect((await Score.findByPk(deleted))!.docState).toEqual(deletedState);
  expect(await Score.count()).toBe(scoresBefore);
});

/** Make Ben a member of the score with this role, as the members API of #13 will. */
async function addBen(scoreId: string, role: Role): Promise<void> {
  await ScoreMember.create({ scoreId, accountId: ben, role });
}


test("what a Viewer's connection sends does not change the score on the server", async () => {
  const { app, url } = await startApp();
  const annaSession = await sessionOf(app, "anna", PASSWORD);
  const id = await createScore(app, annaSession);
  await addBen(id, "viewer");
  const benSession = await sessionOf(app, "ben", PASSWORD);
  const before = docToJson((await open(app, url, id, annaSession)).doc);

  const viewer = await open(app, url, id, benSession);
  const answer = nextSyncStatus(viewer.provider);
  metaOf(viewer.doc).set("title", "Viewer 改的標題");
  expect(await answer).toBe(false);

  // Read back from the server by a new connection, then from the database by a new app.
  expect(docToJson((await open(app, url, id, annaSession)).doc)).toEqual(before);
  await app.close();
  const next = await startApp();
  expect(docToJson((await open(next.app, next.url, id, annaSession)).doc)).toEqual(before);
});

test("ending an account's sessions closes its connections and leaves another account's on the same score open", async () => {
  const { app, url } = await startApp();
  const annaSession = await sessionOf(app, "anna", PASSWORD);
  const id = await createScore(app, annaSession);
  await addBen(id, "editor");
  const anna = await open(app, url, id, annaSession);
  const benScore = await open(app, url, id, await sessionOf(app, "ben", PASSWORD));
  const annaClosed = socketClosed(anna.provider);
  const benClosed = closes(benScore);

  const accountId = (await whoAmI(app, annaSession)).json().accountId as string;
  await app.sessions.end({ accountId });

  expect(await annaClosed).toBe(4401);
  // Ben is still connected: his change reaches the server and is applied.
  const applied = nextSyncStatus(benScore.provider);
  metaOf(benScore.doc).set("title", "Ben 改的標題");
  expect(await applied).toBe(true);
  expect(benClosed()).toBe(false);
});

test("logging out closes the connections of that session only", async () => {
  const { app, url } = await startApp();
  const [leaving, staying] = [await sessionOf(app, "anna", PASSWORD), await sessionOf(app, "anna", PASSWORD)];
  const id = await createScore(app, leaving);
  const left = await open(app, url, id, leaving);
  const kept = await open(app, url, id, staying);
  const leftClosed = socketClosed(left.provider);
  const keptClosed = closes(kept);

  await app.inject({ method: "POST", url: "/api/auth/logout", headers: { origin: ORIGIN }, cookies: { [COOKIE]: leaving } });

  expect(await leftClosed).toBe(4401);
  const applied = nextSyncStatus(kept.provider);
  metaOf(kept.doc).set("title", "另一個分頁改的標題");
  expect(await applied).toBe(true);
  expect(keptClosed()).toBe(false);
});

test("a provider the server disconnects connects again with a ticket it fetched anew", async () => {
  const { app, url } = await startApp();
  const session = await sessionOf(app, "anna", PASSWORD);
  const id = await createScore(app, session);
  const tickets: string[] = [];
  const score = await openScore(url, id, async () => {
    tickets.push(await ticketFor(app, id, session));
    return tickets.at(-1)!;
  });
  opened.push(score);
  const closed = socketClosed(score.provider);

  expect(app.collab.closeConnections({ scoreId: id }, Forbidden)).toBe(1);

  expect(await closed).toBe(4403);
  await insync(score.provider);
  expect(tickets).toHaveLength(2);
  expect(tickets[1]).not.toBe(tickets[0]);
  // The first ticket opened once and is gone; the connection works with the second.
  const applied = nextSyncStatus(score.provider);
  metaOf(score.doc).set("title", "重連之後改的標題");
  expect(await applied).toBe(true);
});

test("a session that ends while the document is being loaded leaves no connection open", async () => {
  const { app, url } = await startApp();
  const session = await sessionOf(app, "anna", PASSWORD);
  const id = await createScore(app, session);
  const ticket = await ticketFor(app, id, session);
  // The ticket has passed onAuthenticate's checks; the session ends while the document comes
  // from Postgres, before the connection is in the register. Loading a document is the one
  // caller of Score.findOne (liveScore in src/scores.ts): the spy stands in that window.
  const load = Score.findOne.bind(Score);
  const loading = vi.spyOn(Score, "findOne").mockImplementationOnce(async (options) => {
    await app.sessions.end({ sessionId: session });
    return load(options);
  });

  const provider = new HocuspocusProvider({ url, name: id, document: new Y.Doc(), token: async () => ticket });
  opened.push({ provider, doc: provider.document });
  const closed = await socketClosed(provider);

  expect(loading).toHaveBeenCalledOnce();
  expect(closed).toBe(4401);
});
