// The versions the server makes on its own (docs/spec/collab.md, section 8): one as the last
// member leaves a score, one every 10 minutes while it stays open, each only when the content is
// not the one of the latest version; at most 200 automatic ones per score. Through real providers.
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

import { docToJson, metaOf, SCHEMA_VERSION, scoreSchema } from "@studio/score-model";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import * as Y from "yjs";

import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import { Score, Version } from "../src/db/models";
import { AUTO_VERSIONS_KEPT, createVersion, MAX_VERSION_BYTES, VERSION_INTERVAL_MS, VersionTooLarge } from "../src/versions";
import { createScore, freshDatabase, freshRedis, listen, nextSyncStatus, type OpenScore, openScore, sessionOf, storedScore, testConfig, ticketFor, warmPool } from "./support";

const PASSWORD = "a password long enough";

let sequelize: Sequelize;
let redis: Redis;
let apps: FastifyInstance[] = [];
let opened: OpenScore[] = [];

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  await createAccount({ username: "anna", displayName: "anna", password: PASSWORD, isAdmin: false, mustChangePassword: false });
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
});

afterAll(async () => {
  await redis.quit();
  await sequelize.close();
});

interface Started {
  app: FastifyInstance;
  url: string;
  session: string;
}

/** A new app on the test database, listening, and a session of anna's there. */
async function startApp(): Promise<Started> {
  const app = buildApp({ config: testConfig(), redis, logger: false });
  apps.push(app);
  const url = await listen(app);
  return { app, url, session: await sessionOf(app, "anna", PASSWORD) };
}

async function open({ app, url, session }: Started, scoreId: string): Promise<OpenScore> {
  const score = await openScore(url, scoreId, () => ticketFor(app, scoreId, session));
  opened.push(score);
  return score;
}

/** Change the title as a member does, and wait until the server has applied the change. */
async function retitle(score: OpenScore, title: string): Promise<void> {
  const applied = nextSyncStatus(score.provider);
  metaOf(score.doc).set("title", title);
  expect(await applied).toBe(true);
}

/** Leave the score, and wait until the server has let go of its document: its version is made by then. */
async function leave({ app }: Started, score: OpenScore): Promise<void> {
  score.provider.destroy();
  await expect.poll(() => app.collab.loadedScores(), { timeout: 5000 }).toEqual([]);
}

/** The versions of the score, the oldest first. */
function versionsOf(scoreId: string): Promise<Version[]> {
  return Version.findAll({ where: { scoreId }, order: [["createdAt", "ASC"]] });
}

/** The titles the versions of the score hold, the oldest first. */
async function titlesOf(scoreId: string): Promise<string[]> {
  return (await versionsOf(scoreId)).map(({ content }) => (JSON.parse(gunzipSync(content).toString()) as { title: string }).title);
}

/** Resolves, when called, once the transactions opened since this call have ended: the versions under way among them. */
function transactionsSince(): () => Promise<void> {
  const transactions = vi.spyOn(Version.sequelize!, "transaction");
  return async () => {
    await Promise.allSettled(transactions.mock.results.map(({ value }) => value as unknown));
  };
}

test("a version is made as the last provider leaves, and none when the content is the one of the latest version", async () => {
  const started = await startApp();
  const id = await createScore(started.app, started.session, "第一版");
  // Making the score, the server's own connection, is no member leaving.
  expect(await Version.count({ where: { scoreId: id } })).toBe(0);

  const first = await open(started, id);
  const second = await open(started, id);
  await retitle(first, "兩個人都在");
  first.provider.destroy();
  // Someone is still there: stored, with no version. The store comes 2 seconds after the change.
  await expect.poll(async () => (await Score.findByPk(id))?.title, { timeout: 5000 }).toBe("兩個人都在");
  expect(await Version.count({ where: { scoreId: id } })).toBe(0);

  await leave(started, second);
  expect(await titlesOf(id)).toEqual(["兩個人都在"]);

  // Opened and left with nothing changed: no version more.
  await leave(started, await open(started, id));
  expect(await titlesOf(id)).toEqual(["兩個人都在"]);

  const again = await open(started, id);
  await retitle(again, "改過了");
  await leave(started, again);
  expect(await titlesOf(id)).toEqual(["兩個人都在", "改過了"]);
  expect((await versionsOf(id)).map(({ reason }) => reason)).toEqual(["last_disconnect", "last_disconnect"]);
});

test("a version holds the score as its members read it: gzipped JSON that passes the schema, with its schema version, hash and size", async () => {
  const started = await startApp();
  const id = await createScore(started.app, started.session, "內容測試");
  const member = await open(started, id);
  await retitle(member, "存下來的內容");
  metaOf(member.doc).set("artist", "某個樂團");
  const read = docToJson(member.doc);
  await leave(started, member);

  const [version, ...others] = await versionsOf(id);
  expect(others).toEqual([]);
  const json = gunzipSync(version!.content).toString();
  const stored = scoreSchema.parse(JSON.parse(json));
  expect(stored).toEqual(read);
  expect(stored.parts.length).toBeGreaterThan(0);
  expect(stored.bars.length).toBeGreaterThan(0);
  expect(version!.schemaVersion).toBe(SCHEMA_VERSION);
  expect(stored.schemaVersion).toBe(SCHEMA_VERSION);
  expect(version!.byteSize).toBe(Buffer.byteLength(json));
  expect(version!.contentHash).toBe(createHash("sha256").update(json).digest("hex"));
  expect([version!.reason, version!.name, version!.createdBy]).toEqual(["last_disconnect", null, null]);
  expect(version!.createdAt).toBeInstanceOf(Date);
});

test("a score edited for 25 minutes gets two timed versions, and none for 10 minutes in which nothing changed", async () => {
  // The interval of the timer only: everything else, the stores and the providers, runs in real time.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const started = await startApp();
  // The intervals that run with no score in memory (making one loads it for a moment).
  const idleTimers = vi.getTimerCount();
  const id = await createScore(started.app, started.session, "定時測試");
  const member = await open(started, id);
  const timed = () => Version.count({ where: { scoreId: id, reason: "interval" } });

  await retitle(member, "第 5 分鐘");
  await vi.advanceTimersByTimeAsync(VERSION_INTERVAL_MS - 1);
  await retitle(member, "第 10 分鐘");
  expect(await timed()).toBe(0);
  await vi.advanceTimersByTimeAsync(1);
  await expect.poll(timed).toBe(1);

  await retitle(member, "第 20 分鐘");
  await vi.advanceTimersByTimeAsync(VERSION_INTERVAL_MS);
  await expect.poll(timed).toBe(2);

  await retitle(member, "第 25 分鐘");
  await vi.advanceTimersByTimeAsync(VERSION_INTERVAL_MS / 2);
  // Leaving makes the version that follows the timed ones: by then, 25 minutes gave two.
  await leave(started, member);
  expect(await titlesOf(id)).toEqual(["第 10 分鐘", "第 20 分鐘", "第 25 分鐘"]);
  expect((await versionsOf(id)).map(({ reason }) => reason)).toEqual(["interval", "interval", "last_disconnect"]);

  // Open for 10 minutes with nothing changed: no version, timed or not. The timer of the first
  // stay ended with it: a tick of it would come 5 minutes in, and find nothing to do either.
  const idle = await open(started, id);
  const ticks = transactionsSince();
  await vi.advanceTimersByTimeAsync(VERSION_INTERVAL_MS);
  // The tick reads the score once it has the row: it is over before the change, or it would
  // make the version of the change.
  await ticks();
  await retitle(idle, "又改了");
  await leave(started, idle);
  expect(await titlesOf(id)).toEqual(["第 10 分鐘", "第 20 分鐘", "第 25 分鐘", "又改了"]);
  expect(await timed()).toBe(2);

  // Nobody has it open: its timer is gone, and nothing makes a version.
  await expect.poll(() => vi.getTimerCount()).toBe(idleTimers);
  const made = vi.spyOn(Version, "create");
  await vi.advanceTimersByTimeAsync(3 * VERSION_INTERVAL_MS);
  expect(made).not.toHaveBeenCalled();
});

/**
 * Hold the next transaction opened on the database at its start, before it has locked anything:
 * `held` resolves once it is reached, `release()` lets it run, and `ended` resolves once it is over.
 */
function holdNextTransaction(): { held: Promise<void>; release: () => void; ended: () => Promise<unknown> } {
  const database = Version.sequelize!;
  const transaction = database.transaction.bind(database) as (run: (t: unknown) => Promise<unknown>) => Promise<unknown>;
  let reached = () => {};
  const held = new Promise<void>((resolve) => (reached = resolve));
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let running: Promise<unknown> = held;
  vi.spyOn(database, "transaction").mockImplementationOnce(((run: (t: unknown) => Promise<unknown>) => {
    running = released.then(() => transaction(run));
    reached();
    return running;
  }) as never);
  return { held, release, ended: () => running };
}

test("a timed version held back until the members have changed the score and left never makes the older content the latest version", async () => {
  // #114: the tick reads the score, then waits (gzip, a connection of the pool); meanwhile a
  // member changes it and leaves, and that version is made first. Here the tick is held at the
  // start of its transaction until the other version is made.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const started = await startApp();
  const id = await createScore(started.app, started.session, "順序測試");
  const member = await open(started, id);
  await retitle(member, "第 10 分鐘");
  await vi.advanceTimersByTimeAsync(VERSION_INTERVAL_MS);
  await expect.poll(() => titlesOf(id)).toEqual(["第 10 分鐘"]);

  const tick = holdNextTransaction();
  // The tick of minute 20: the content is still the one of the latest version.
  await vi.advanceTimersByTimeAsync(VERSION_INTERVAL_MS);
  await tick.held;

  await retitle(member, "第 20 分鐘後改的");
  await leave(started, member);
  expect(await titlesOf(id)).toEqual(["第 10 分鐘", "第 20 分鐘後改的"]);
  tick.release();
  await tick.ended();

  // The latest version is what the score is: the tick made none.
  expect(await titlesOf(id)).toEqual(["第 10 分鐘", "第 20 分鐘後改的"]);
  expect((await versionsOf(id)).map(({ reason }) => reason)).toEqual(["interval", "last_disconnect"]);
});

test("a timed version held back until its document was unloaded, loaded again and versioned makes none of the document it started with", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const started = await startApp();
  const id = await createScore(started.app, started.session, "重新載入測試");
  const first = await open(started, id);
  await retitle(first, "第一次開");

  // The tick of the first stay, held before it has the row.
  const tick = holdNextTransaction();
  await vi.advanceTimersByTimeAsync(VERSION_INTERVAL_MS);
  await tick.held;

  // Meanwhile the members leave, and the score is opened again, changed, and versioned by the
  // tick of the second stay.
  await leave(started, first);
  expect(await titlesOf(id)).toEqual(["第一次開"]);
  const second = await open(started, id);
  await retitle(second, "第二次開");
  await vi.advanceTimersByTimeAsync(VERSION_INTERVAL_MS);
  await expect.poll(() => titlesOf(id)).toEqual(["第一次開", "第二次開"]);

  tick.release();
  await tick.ended();

  // The first document is no longer the score: its tick made none, the latest is still the second stay's.
  expect(await titlesOf(id)).toEqual(["第一次開", "第二次開"]);
  expect((await versionsOf(id)).map(({ reason }) => reason)).toEqual(["last_disconnect", "interval"]);
});

test("the 201st automatic version deletes the oldest automatic one, and no named one", async () => {
  const started = await startApp();
  const id = await createScore(started.app, started.session, "保留測試");
  const other = await createScore(started.app, started.session, "別的團譜");
  const day = 24 * 60 * 60 * 1000;
  const old = (scoreId: string, daysAgo: number, name: string | null) => ({
    scoreId,
    schemaVersion: SCHEMA_VERSION,
    content: Buffer.from("old"),
    contentHash: `${daysAgo}`.padStart(64, "0"),
    byteSize: 3,
    reason: "interval" as const,
    name,
    createdAt: new Date(Date.now() - daysAgo * day),
  });
  // 200 automatic versions, 1 to 200 days old; two named ones, older than all of them and in their middle.
  const automatic = await Version.bulkCreate(Array.from({ length: AUTO_VERSIONS_KEPT }, (_, index) => old(id, index + 1, null)));
  const named = await Version.bulkCreate([old(id, 300, "最早的錄音版"), old(id, 100.5, "中間的版本")]);
  // Another score at its limit: its versions are its own.
  await Version.bulkCreate(Array.from({ length: AUTO_VERSIONS_KEPT }, (_, index) => old(other, index + 1, null)));
  const ids = async () => new Set((await versionsOf(id)).map((version) => version.id));

  const member = await open(started, id);
  await retitle(member, "第 201 個");
  await leave(started, member);

  const kept = await ids();
  expect(await Version.count({ where: { scoreId: id, name: null } })).toBe(AUTO_VERSIONS_KEPT);
  expect(kept.has(automatic[AUTO_VERSIONS_KEPT - 1]!.id)).toBe(false);
  expect(kept.has(automatic[AUTO_VERSIONS_KEPT - 2]!.id)).toBe(true);
  for (const version of named) expect(kept.has(version.id)).toBe(true);
  expect(await Version.count({ where: { scoreId: other } })).toBe(AUTO_VERSIONS_KEPT);

  // The next one takes the next oldest along.
  const again = await open(started, id);
  await retitle(again, "第 202 個");
  await leave(started, again);
  expect(await Version.count({ where: { scoreId: id, name: null } })).toBe(AUTO_VERSIONS_KEPT);
  expect((await ids()).has(automatic[AUTO_VERSIONS_KEPT - 2]!.id)).toBe(false);
  expect(await Version.count({ where: { scoreId: id } })).toBe(AUTO_VERSIONS_KEPT + 2);
});

test("the same content is the same version however its keys are ordered, and a score no longer there gets none", async () => {
  const started = await startApp();
  const id = await createScore(started.app, started.session, "雜湊測試");
  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await Score.findByPk(id))!.docState);
  const score = docToJson(doc);
  const reversed = Object.fromEntries(Object.entries(score).reverse()) as typeof score;

  const made = await createVersion(id, { read: () => score, reason: "interval" });
  expect(made?.created).toBe(true);
  expect(await createVersion(id, { read: () => reversed, reason: "last_disconnect" })).toEqual({ id: made!.id, created: false });
  expect((await createVersion(id, { read: () => ({ ...score, title: "另一個標題" }), reason: "last_disconnect" }))?.created).toBe(true);
  // Back to the first content: not the latest one any more, so a version again.
  expect((await createVersion(id, { read: () => score, reason: "last_disconnect" }))?.created).toBe(true);
  expect(await Version.count({ where: { scoreId: id } })).toBe(3);

  expect(
    await createVersion(
      "00000000-0000-4000-8000-000000000000",
      {
        read: () => {
          throw new Error("no score: nothing to read");
        },
        reason: "interval",
      },
    ),
  ).toBeNull();
});

test("a score written by a newer schema gets no version: this server cannot read it for sure", async () => {
  const started = await startApp();
  const id = await createScore(started.app, started.session, "較新的團譜");
  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await Score.findByPk(id))!.docState);
  metaOf(doc).set("schemaVersion", SCHEMA_VERSION + 1);
  await Score.update({ docState: Buffer.from(Y.encodeStateAsUpdate(doc)), schemaVersion: SCHEMA_VERSION + 1 }, { where: { id } });

  await leave(started, await open(started, id));

  expect(await Version.count({ where: { scoreId: id } })).toBe(0);
});

test("a server that closes makes a version of the scores its members still have open", async () => {
  const started = await startApp();
  const id = await createScore(started.app, started.session, "關機測試");
  const member = await open(started, id);
  await retitle(member, "關機前改的");

  await started.app.close();
  apps = [];

  expect(await titlesOf(id)).toEqual(["關機前改的"]);
});

test("a version that cannot be made is logged, and the score is stored and unloaded all the same", async () => {
  const started = await startApp();
  const id = await createScore(started.app, started.session, "失敗測試");
  const logged = vi.spyOn(started.app.log, "error");
  vi.spyOn(Version, "create").mockRejectedValueOnce(new Error("no version this time"));
  const member = await open(started, id);
  await retitle(member, "沒有版本的修改");

  await leave(started, member);

  expect(await Version.count({ where: { scoreId: id } })).toBe(0);
  expect(logged).toHaveBeenCalledWith(expect.objectContaining({ scoreId: id, reason: "last_disconnect" }), "making a version of a score failed");
  expect((await Score.findByPk(id))?.title).toBe("沒有版本的修改");
  // The next time the members leave, the version is made of what the score is then.
  await leave(started, await open(started, id));
  expect(await titlesOf(id)).toEqual(["沒有版本的修改"]);
});

test("two versions of the same content asked for at once make one", async () => {
  const started = await startApp();
  const id = await createScore(started.app, started.session, "同時建立");
  const score = await storedScore(id);
  await warmPool(sequelize);

  const made = await Promise.all(Array.from({ length: 4 }, () => createVersion(id, { read: () => score, reason: "interval" })));

  expect(await Version.count({ where: { scoreId: id } })).toBe(1);
  expect(made.filter((version) => version?.created)).toHaveLength(1);
  expect(new Set(made.map((version) => version?.id)).size).toBe(1);
});

test("versions made at once near the limit never leave more than 200 automatic ones", async () => {
  const started = await startApp();
  const id = await createScore(started.app, started.session, "同時到上限");
  const score = await storedScore(id);
  const hour = 60 * 60 * 1000;
  const automatic = await Version.bulkCreate(
    Array.from({ length: AUTO_VERSIONS_KEPT - 1 }, (_, index) => ({
      scoreId: id,
      schemaVersion: SCHEMA_VERSION,
      content: Buffer.from("old"),
      contentHash: `${index}`.padStart(64, "0"),
      byteSize: 3,
      reason: "interval" as const,
      createdAt: new Date(Date.now() - (index + 1) * hour),
    })),
  );
  await warmPool(sequelize);

  const made = await Promise.all(Array.from({ length: 5 }, (_, index) => createVersion(id, { read: () => ({ ...score, title: `同時的第 ${index} 個` }), reason: "interval" })));

  expect(made.map((version) => version?.created)).toEqual([true, true, true, true, true]);
  expect(await Version.count({ where: { scoreId: id } })).toBe(AUTO_VERSIONS_KEPT);
  // The five new ones are all there; the four oldest went.
  const kept = new Set((await versionsOf(id)).map((version) => version.id));
  for (const version of made) expect(kept.has(version!.id)).toBe(true);
  expect(automatic.slice(-5).map((version) => kept.has(version.id))).toEqual([true, false, false, false, false]);
});

test("the database refuses a version with a reason it does not know", async () => {
  const started = await startApp();
  const id = await createScore(started.app, started.session, "原因測試");
  const row = { scoreId: id, schemaVersion: SCHEMA_VERSION, content: Buffer.from("x"), contentHash: "0".repeat(64), byteSize: 1 };

  await expect(Version.create({ ...row, reason: "restored" as never })).rejects.toThrow(/versions_reason_check/);

  expect(await Version.count({ where: { scoreId: id } })).toBe(0);
  for (const reason of ["last_disconnect", "interval", "before_restore", "manual"] as const) await Version.create({ ...row, reason });
  expect(await Version.count({ where: { scoreId: id } })).toBe(4);
});

test("content of more than 8 MB of JSON makes no version, and one of exactly as much does", async () => {
  const started = await startApp();
  const id = await createScore(started.app, started.session, "大小測試");
  const score = await storedScore(id);
  const sized = (bytes: number) => {
    const empty = Buffer.byteLength(JSON.stringify({ ...score, title: "" }));
    return { ...score, title: "a".repeat(bytes - empty) };
  };

  await expect(createVersion(id, { read: () => sized(MAX_VERSION_BYTES + 1), reason: "interval" })).rejects.toThrow(VersionTooLarge);
  expect(await Version.count({ where: { scoreId: id } })).toBe(0);

  expect((await createVersion(id, { read: () => sized(MAX_VERSION_BYTES), reason: "interval" }))?.created).toBe(true);
  const [version] = await versionsOf(id);
  expect(version!.byteSize).toBe(MAX_VERSION_BYTES);
});
