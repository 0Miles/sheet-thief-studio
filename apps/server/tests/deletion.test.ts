// Deleting a score (docs/spec/accounts.md, sections 8 and 9; docs/spec/routes.md, 3.3): the
// Owner deletes it softly and restores it within 30 days; meanwhile nobody finds it, and the
// connections it had are closed, through real providers; after 30 days the job of the server
// deletes it for good.
import { gunzipSync } from "node:zlib";

import { Forbidden } from "@hocuspocus/common";
import { docToJson, metaOf } from "@studio/score-model";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { QueryTypes, type Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import * as Y from "yjs";

import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import { Score, ScoreMember, Version } from "../src/db/models";
import { PURGE_INTERVAL_MS, purgeDeletedScores } from "../src/deletion";
import { createVersion, VERSION_INTERVAL_MS } from "../src/versions";
import { askTicket, COOKIE, createScore, freshDatabase, freshRedis, listen, nextSyncStatus, type OpenScore, openScore, ORIGIN, sessionOf, socketClosed, testConfig, ticketFor } from "./support";

const PASSWORD = "a password long enough";

let sequelize: Sequelize;
let redis: Redis;
let apps: FastifyInstance[] = [];
let opened: OpenScore[] = [];

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  for (const username of ["anna", "ben", "cara"]) {
    await createAccount({ username, displayName: `${username} 的名字`, password: PASSWORD, isAdmin: false, mustChangePassword: false });
  }
});

beforeEach(async () => {
  await redis.flushdb();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { provider } of opened) provider.destroy();
  for (const app of apps) await app.close();
  vi.useRealTimers();
  apps = [];
  opened = [];
  // Each test counts the scores it made.
  await Score.destroy({ where: {} });
});

afterAll(async () => {
  await redis.quit();
  await sequelize.close();
});

async function startApp(): Promise<{ app: FastifyInstance; url: string }> {
  const app = buildApp({ config: testConfig(), redis, logger: false });
  apps.push(app);
  return { app, url: await listen(app) };
}

/** A call of the API as the pages make it, on a path under `/api/`. */
function call(app: FastifyInstance, method: "GET" | "POST" | "DELETE", path: string, session: string | null) {
  return app.inject({ method, url: `/api/${path}`, headers: { origin: ORIGIN }, ...(session === null ? {} : { cookies: { [COOKIE]: session } }) });
}

/** A score of Anna, Ben its Editor, Cara no member, with a session of each. */
async function annasScore(app: FastifyInstance, title = "刪除測試") {
  const [anna, ben, cara] = await Promise.all(["anna", "ben", "cara"].map((username) => sessionOf(app, username, PASSWORD)));
  const id = await createScore(app, anna!, title);
  const added = await app.inject({ method: "POST", url: `/api/scores/${id}/members`, headers: { origin: ORIGIN }, cookies: { [COOKIE]: anna! }, payload: { username: "ben" } });
  expect(added.statusCode).toBe(201);
  return { id, anna: anna!, ben: ben!, cara: cara! };
}

async function makeLink(app: FastifyInstance, scoreId: string, session: string): Promise<string> {
  const response = await call(app, "POST", `scores/${scoreId}/link`, session);
  expect(response.statusCode).toBe(200);
  return (response.json() as { token: string }).token;
}

async function guestTicketFor(app: FastifyInstance, token: string): Promise<string> {
  const response = await call(app, "POST", `s/${token}`, null);
  if (response.statusCode !== 200) throw new Error(`the ticket of the guest was refused: ${response.statusCode}`);
  return (response.json() as { ticket: string }).ticket;
}

async function open(url: string, scoreId: string, token: () => Promise<string>): Promise<OpenScore> {
  const score = await openScore(url, scoreId, token);
  opened.push(score);
  return score;
}

async function listed(app: FastifyInstance, path: "scores" | "scores/deleted", session: string): Promise<string[]> {
  const response = await call(app, "GET", path, session);
  expect(response.statusCode).toBe(200);
  return (response.json() as { scores: { id: string }[] }).scores.map(({ id }) => id);
}

/** Make the score one deleted this long ago, by the clock of the database (an interval of Postgres, such as `29 days`). */
async function deletedFor(scoreId: string, interval: string): Promise<void> {
  await sequelize.query("UPDATE scores SET deleted_at = now() - $1::interval WHERE id = $2", { bind: [interval, scoreId] });
}

/** What each way of reaching the score answers to this member: its details, its members, a collab ticket. */
async function reaches(app: FastifyInstance, scoreId: string, session: string): Promise<number[]> {
  const answers = [await call(app, "GET", `scores/${scoreId}`, session), await call(app, "GET", `scores/${scoreId}/members`, session), await askTicket(app, scoreId, session)];
  return answers.map((answer) => answer.statusCode);
}

test("once deleted, the score answers 404 to the API and the collab tickets of its members and to its read-only link, and their providers are closed", async () => {
  const { app, url } = await startApp();
  const { id, anna, ben } = await annasScore(app);
  const other = await createScore(app, anna, "留下來的團譜");
  const token = await makeLink(app, id, anna);
  const providers = [await open(url, id, () => ticketFor(app, id, anna)), await open(url, id, () => ticketFor(app, id, ben)), await open(url, id, () => guestTicketFor(app, token))];
  const kept = await open(url, other, () => ticketFor(app, other, anna));
  const closed = providers.map(({ provider }) => socketClosed(provider));
  let keptClosed = false;
  void socketClosed(kept.provider).then(() => (keptClosed = true));

  const deleted = await call(app, "DELETE", `scores/${id}`, anna);
  expect([deleted.statusCode, deleted.body]).toEqual([204, ""]);

  expect(await Promise.all(closed)).toEqual([Forbidden.code, Forbidden.code, Forbidden.code]);
  for (const session of [anna, ben]) {
    expect(await reaches(app, id, session)).toEqual([404, 404, 404]);
    expect(await listed(app, "scores", session)).not.toContain(id);
  }
  expect((await call(app, "GET", `scores/${id}`, anna)).json()).toEqual({ code: "not_found" });
  expect((await call(app, "GET", `scores/${id}/link`, anna)).statusCode).toBe(404);
  expect((await call(app, "POST", `s/${token}`, null)).statusCode).toBe(404);
  // Deleted softly: the row, its content and its members are all there, the link is not.
  const row = await Score.findByPk(id);
  expect(row?.deletedAt).toBeInstanceOf(Date);
  expect(row?.linkToken).toBeNull();
  expect(await ScoreMember.count({ where: { scoreId: id } })).toBe(2);
  // Deleting it again finds nothing.
  expect((await call(app, "DELETE", `scores/${id}`, anna)).statusCode).toBe(404);

  // The other score is as it was.
  const applied = nextSyncStatus(kept.provider);
  kept.doc.getMap("meta").set("title", "還在的團譜");
  expect(await applied).toBe(true);
  expect(keptClosed).toBe(false);
});

test("a ticket given before the deletion opens nothing after it", async () => {
  const { app, url } = await startApp();
  const { id, anna } = await annasScore(app);
  const ticket = await ticketFor(app, id, anna);
  expect((await call(app, "DELETE", `scores/${id}`, anna)).statusCode).toBe(204);

  await expect(open(url, id, async () => ticket)).rejects.toThrow("refused");
  expect(app.collab.loadedScores()).not.toContain(id);
});

test("restored, the score is back for its members as it was, without its read-only link", async () => {
  const { app, url } = await startApp();
  const { id, anna, ben } = await annasScore(app, "還原測試");
  const token = await makeLink(app, id, anna);
  const before = await Score.findByPk(id);
  expect((await call(app, "DELETE", `scores/${id}`, anna)).statusCode).toBe(204);
  expect((await call(app, "GET", "scores/deleted", anna)).json()).toEqual({ scores: [{ id, title: "還原測試", artist: null, deletedAt: expect.any(String) }] });

  const restored = await call(app, "POST", `scores/${id}/restore`, anna);
  expect([restored.statusCode, restored.body]).toEqual([204, ""]);

  expect(await listed(app, "scores/deleted", anna)).toEqual([]);
  for (const session of [anna, ben]) {
    expect(await reaches(app, id, session)).toEqual([200, 200, 200]);
    expect(await listed(app, "scores", session)).toEqual([id]);
  }
  const members = (await call(app, "GET", `scores/${id}/members`, ben)).json() as { members: { username: string; role: string }[] };
  expect(members.members.map(({ username, role }) => [username, role])).toEqual([
    ["anna", "owner"],
    ["ben", "editor"],
  ]);
  const reopened = await open(url, id, () => ticketFor(app, id, ben));
  expect(reopened.doc.getMap("meta").get("title")).toBe("還原測試");
  // Neither the deletion nor the restoration is a change of the score.
  expect((await Score.findByPk(id))?.updatedAt).toEqual(before?.updatedAt);
  // The link did not come back: the old token opens nothing, and the Owner has none to copy.
  expect((await call(app, "POST", `s/${token}`, null)).statusCode).toBe(404);
  expect((await call(app, "GET", `scores/${id}/link`, anna)).json()).toEqual({ token: null });
  // Restoring a score that is not deleted finds nothing.
  expect((await call(app, "POST", `scores/${id}/restore`, anna)).statusCode).toBe(404);
});

test("only the Owner deletes, restores and sees the deleted scores", async () => {
  const { app } = await startApp();
  const { id, anna, ben, cara } = await annasScore(app);

  const refused = await call(app, "DELETE", `scores/${id}`, ben);
  expect([refused.statusCode, refused.json()]).toEqual([403, { code: "forbidden" }]);
  expect((await call(app, "DELETE", `scores/${id}`, cara)).statusCode).toBe(404);
  expect((await call(app, "DELETE", `scores/${id}`, null)).statusCode).toBe(401);
  expect((await call(app, "DELETE", "scores/not-an-id", anna)).statusCode).toBe(404);
  expect((await Score.findByPk(id))?.deletedAt).toBeNull();
  expect(await reaches(app, id, ben)).toEqual([200, 200, 200]);

  expect((await call(app, "DELETE", `scores/${id}`, anna)).statusCode).toBe(204);

  // To a member who is not its Owner the deleted score is nowhere, like to anyone else.
  for (const session of [ben, cara]) {
    expect(await listed(app, "scores/deleted", session)).toEqual([]);
    const answer = await call(app, "POST", `scores/${id}/restore`, session);
    expect([answer.statusCode, answer.json()]).toEqual([404, { code: "not_found" }]);
  }
  expect((await call(app, "POST", `scores/${id}/restore`, null)).statusCode).toBe(401);
  expect((await call(app, "GET", "scores/deleted", null)).statusCode).toBe(401);
  expect((await call(app, "POST", "scores/not-an-id/restore", anna)).statusCode).toBe(404);
  expect((await Score.findByPk(id))?.deletedAt).toBeInstanceOf(Date);
  expect(await listed(app, "scores/deleted", anna)).toEqual([id]);
});

test("the deleted scores are listed the last deleted first, without the ones I do not own", async () => {
  const { app } = await startApp();
  const anna = await sessionOf(app, "anna", PASSWORD);
  const ben = await sessionOf(app, "ben", PASSWORD);
  const first = await createScore(app, anna, "先刪的");
  const second = await createScore(app, anna, "後刪的");
  const bens = await createScore(app, ben, "別人的");
  await createScore(app, anna, "沒刪的");
  for (const [id, session] of [
    [first, anna],
    [second, anna],
    [bens, ben],
  ] as const) {
    expect((await call(app, "DELETE", `scores/${id}`, session)).statusCode).toBe(204);
  }
  expect(await listed(app, "scores/deleted", anna)).toEqual([second, first]);
  expect(await listed(app, "scores/deleted", ben)).toEqual([bens]);
});

test("the hourly job leaves a score deleted 29 days ago, and deletes one deleted 31 days ago for good, with its members and its versions", async () => {
  // The interval of the job only: the clock that says how long ago a score was deleted is the one of the database.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { app } = await startApp();
  const { id, anna } = await annasScore(app);
  const live = await createScore(app, anna, "沒刪的");
  // Two versions of each, as the server makes them.
  for (const scoreId of [id, live]) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, (await Score.findByPk(scoreId))!.docState);
    const score = docToJson(doc);
    expect((await createVersion(scoreId, score, "last_disconnect"))?.created).toBe(true);
    expect((await createVersion(scoreId, { ...score, title: "後來的標題" }, "interval"))?.created).toBe(true);
  }
  expect((await call(app, "DELETE", `scores/${id}`, anna)).statusCode).toBe(204);
  const destroy = vi.spyOn(Score, "destroy");
  /** Let the next run of the job come, and end. */
  const nextRun = async () => {
    const runs = destroy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(PURGE_INTERVAL_MS);
    expect(destroy.mock.calls.length).toBe(runs + 1);
    await destroy.mock.results.at(-1)!.value;
  };

  await deletedFor(id, "29 days");
  await nextRun();
  expect(await Score.count({ where: { id } })).toBe(1);
  expect(await ScoreMember.count({ where: { scoreId: id } })).toBe(2);
  expect(await Version.count({ where: { scoreId: id } })).toBe(2);
  expect(await listed(app, "scores/deleted", anna)).toEqual([id]);

  // Past the 30 days, before the job comes by: already out of reach of the Owner.
  await deletedFor(id, "30 days 1 minute");
  expect(await listed(app, "scores/deleted", anna)).toEqual([]);
  expect((await call(app, "POST", `scores/${id}/restore`, anna)).statusCode).toBe(404);
  expect(await Score.count({ where: { id } })).toBe(1);

  await deletedFor(id, "31 days");
  await nextRun();
  expect(await Score.count({ where: { id } })).toBe(0);
  expect(await ScoreMember.count({ where: { scoreId: id } })).toBe(0);
  expect(await Version.count({ where: { scoreId: id } })).toBe(0);
  expect(await Version.count({ where: { scoreId: live } })).toBe(2);
  // Nothing that is not deleted goes, however old.
  await sequelize.query("UPDATE scores SET created_at = now() - interval '2 years', updated_at = now() - interval '1 year' WHERE id = $1", { bind: [live] });
  await nextRun();
  expect(await Score.count({ where: { id: live } })).toBe(1);
  expect(await ScoreMember.count({ where: { scoreId: live } })).toBe(1);
  expect(await Version.count({ where: { scoreId: live } })).toBe(2);
  expect(await listed(app, "scores", anna)).toEqual([live]);
});

test("how long ago a score was deleted is told by the clock of the database, not by the one of the server", async () => {
  // The clock of the process jumps two months ahead: nothing deleted a moment ago goes.
  vi.useFakeTimers({ toFake: ["Date"] });
  const { app } = await startApp();
  const { id, anna } = await annasScore(app);
  vi.setSystemTime(Date.now() + 60 * 24 * 60 * 60 * 1000);
  expect((await call(app, "DELETE", `scores/${id}`, anna)).statusCode).toBe(204);
  vi.setSystemTime(Date.now() + 60 * 24 * 60 * 60 * 1000);

  expect(await purgeDeletedScores()).toBe(0);
  expect(await listed(app, "scores/deleted", anna)).toEqual([id]);
  const [row] = await sequelize.query<{ recent: boolean }>("SELECT deleted_at BETWEEN now() - interval '1 minute' AND now() AS recent FROM scores WHERE id = $1", { bind: [id], type: QueryTypes.SELECT });
  expect(row?.recent).toBe(true);
  expect((await call(app, "POST", `scores/${id}/restore`, anna)).statusCode).toBe(204);
});

test("the job runs once as the server starts", async () => {
  const { app } = await startApp();
  const { id, anna } = await annasScore(app);
  expect((await call(app, "DELETE", `scores/${id}`, anna)).statusCode).toBe(204);
  await deletedFor(id, "31 days");
  expect(await Score.count({ where: { id } })).toBe(1);

  const next = buildApp({ config: testConfig(), redis, logger: false });
  apps.push(next);
  await next.ready();

  expect(await Score.count({ where: { id } })).toBe(0);
});

test("a run of the job under way ends before the app is closed", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const app = buildApp({ config: testConfig(), redis, logger: false });
  apps.push(app);
  // What whoever built the app does as it closes (src/main.ts closes the database there).
  let endedAtClose: boolean | null = null;
  app.addHook("onClose", async () => {
    endedAtClose = ended;
  });
  await app.ready();
  let ended = false;
  let release = () => {};
  vi.spyOn(Score, "destroy").mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => (release = resolve));
    ended = true;
    return 0;
  });
  await vi.advanceTimersByTimeAsync(PURGE_INTERVAL_MS);

  const closing = app.close();
  setTimeout(release, 50);
  await closing;

  expect(endedAtClose).toBe(true);
});

test("a score restored while the job waits for it is not deleted", async () => {
  const { app } = await startApp();
  const { id, anna } = await annasScore(app);
  expect((await call(app, "DELETE", `scores/${id}`, anna)).statusCode).toBe(204);
  await deletedFor(id, "31 days");
  // The job comes by while a restoration holds the row.
  let waiting: Promise<number> | undefined;
  await sequelize.transaction(async (transaction) => {
    await Score.findByPk(id, { lock: transaction.LOCK.UPDATE, transaction });
    waiting = purgeDeletedScores();
    await Score.update({ deletedAt: null }, { where: { id }, silent: true, transaction });
  });
  expect(await waiting).toBe(0);
  expect(await Score.count({ where: { id } })).toBe(1);
});

test("a link asked for as the score is deleted is not made, and none comes back with the restoration", async () => {
  const { app } = await startApp();
  const { id, anna } = await annasScore(app);
  // The request for a link has passed the check of its Owner; the score is deleted before the
  // request locks its row: the first locked read of a score is that one, and the deletion runs
  // to its end in front of it.
  const find = Score.findOne.bind(Score);
  let deleted: number | null = null;
  vi.spyOn(Score, "findOne").mockImplementation(async (options) => {
    if (options?.lock !== undefined && deleted === null) {
      deleted = 0;
      deleted = (await call(app, "DELETE", `scores/${id}`, anna)).statusCode;
    }
    return find(options);
  });

  const made = await call(app, "POST", `scores/${id}/link`, anna);

  expect(deleted).toBe(204);
  expect([made.statusCode, made.json()]).toEqual([404, { code: "not_found" }]);
  expect((await Score.findByPk(id))?.linkToken).toBeNull();
  expect((await call(app, "POST", `scores/${id}/restore`, anna)).statusCode).toBe(204);
  expect((await call(app, "GET", `scores/${id}/link`, anna)).json()).toEqual({ token: null });
});

test("a restoration clears whatever link the deleted row holds", async () => {
  const { app } = await startApp();
  const { id, anna } = await annasScore(app);
  expect((await call(app, "DELETE", `scores/${id}`, anna)).statusCode).toBe(204);
  const token = "t".repeat(43);
  await Score.update({ linkToken: token }, { where: { id }, silent: true });

  expect((await call(app, "POST", `scores/${id}/restore`, anna)).statusCode).toBe(204);

  expect((await Score.findByPk(id))?.linkToken).toBeNull();
  expect((await call(app, "POST", `s/${token}`, null)).statusCode).toBe(404);
});

test("what a member typed just before the deletion is stored as the connections close, without a new updated_at; nothing is written after that", async () => {
  const { app, url } = await startApp();
  const { id, anna } = await annasScore(app, "刪除前的標題");
  const unloaded = () => vi.waitFor(() => expect(app.collab.loadedScores()).not.toContain(id), { timeout: 5000 });
  const member = await open(url, id, () => ticketFor(app, id, anna));
  const before = (await Score.findByPk(id))!;
  const applied = nextSyncStatus(member.provider);
  metaOf(member.doc).set("title", "刪除前剛改的標題");
  expect(await applied).toBe(true);
  // Not stored yet: the store waits two seconds for more changes.
  expect((await Score.findByPk(id))?.title).toBe("刪除前的標題");

  expect((await call(app, "DELETE", `scores/${id}`, anna)).statusCode).toBe(204);
  member.provider.destroy();
  await unloaded();

  const stored = (await Score.findByPk(id))!;
  const doc = new Y.Doc();
  Y.applyUpdate(doc, stored.docState);
  expect(metaOf(doc).get("title")).toBe("刪除前剛改的標題");
  expect(stored.title).toBe("刪除前剛改的標題");
  expect(stored.deletedAt).toBeInstanceOf(Date);
  expect(stored.updatedAt).toEqual(before.updatedAt);

  // Longer than the debounce of a store and the one of a fill: no write comes after the last one.
  const update = vi.spyOn(Score, "update");
  await new Promise((resolve) => setTimeout(resolve, 3000));
  expect(update).not.toHaveBeenCalled();
  expect((await Score.findByPk(id))?.docState.equals(stored.docState)).toBe(true);
  update.mockRestore();

  // Restored, a change is a change again.
  expect((await call(app, "POST", `scores/${id}/restore`, anna)).statusCode).toBe(204);
  const again = await open(url, id, () => ticketFor(app, id, anna));
  expect(metaOf(again.doc).get("title")).toBe("刪除前剛改的標題");
  const changed = nextSyncStatus(again.provider);
  metaOf(again.doc).set("title", "還原後改的標題");
  expect(await changed).toBe(true);
  again.provider.destroy();
  await unloaded();
  const after = (await Score.findByPk(id))!;
  expect(after.title).toBe("還原後改的標題");
  expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
});

test("a score deleted while a member has it open gets the version of what they left, none after that, and keeps its versions when it is restored", async () => {
  // The interval of the timers only: the one of the versions, and the one of the job.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const { app, url } = await startApp();
  const { id, anna } = await annasScore(app, "刪除前的標題");
  const member = await open(url, id, () => ticketFor(app, id, anna));
  const applied = nextSyncStatus(member.provider);
  metaOf(member.doc).set("title", "刪除前剛改的標題");
  expect(await applied).toBe(true);
  expect(await Version.count({ where: { scoreId: id } })).toBe(0);

  // The deletion closes the member's connection, the last one: that is the version.
  expect((await call(app, "DELETE", `scores/${id}`, anna)).statusCode).toBe(204);
  member.provider.destroy();
  await vi.waitFor(() => expect(app.collab.loadedScores()).not.toContain(id), { timeout: 5000 });
  const versions = await Version.findAll({ where: { scoreId: id } });
  expect(versions.map(({ reason }) => reason)).toEqual(["last_disconnect"]);
  expect((await Score.findByPk(id))?.deletedAt).toBeInstanceOf(Date);

  // Deleted, nobody opens it: no timer makes another.
  const made = vi.spyOn(Version, "create");
  await vi.advanceTimersByTimeAsync(3 * VERSION_INTERVAL_MS);
  expect(made).not.toHaveBeenCalled();
  expect(await Version.count({ where: { scoreId: id } })).toBe(1);

  expect((await call(app, "POST", `scores/${id}/restore`, anna)).statusCode).toBe(204);
  const kept = await Version.findAll({ where: { scoreId: id } });
  expect(kept.map((version) => version.id)).toEqual(versions.map((version) => version.id));
  expect((JSON.parse(gunzipSync(kept[0]!.content).toString()) as { title: string }).title).toBe("刪除前剛改的標題");
});

test("every table that refers to a score goes with it: its foreign key cascades", async () => {
  const keys = await sequelize.query<{ table: string; name: string; action: string }>(
    "SELECT conrelid::regclass::text AS table, conname AS name, confdeltype::text AS action FROM pg_constraint WHERE contype = 'f' AND confrelid = 'scores'::regclass",
    { type: QueryTypes.SELECT },
  );
  // `c` is ON DELETE CASCADE. A table added without it would make the job fail on every score that has rows there.
  expect(keys.map(({ table }) => table).sort()).toEqual(["score_members", "versions"]);
  expect(keys.filter(({ action }) => action !== "c")).toEqual([]);
});
