// What members do with a score's versions (docs/spec/routes.md, 3.6; docs/spec/collab.md, 8.4
// to 8.6): every member lists and reads them, brought to the current schema; an Owner or an
// Editor names one, and makes one now; anyone else is told there is no such score.
import { gzipSync } from "node:zlib";

import { versionList, versionSummary } from "@studio/contracts";
import { docToJson, metaOf, migrateJson, SCHEMA_VERSION, scoreSchema } from "@studio/score-model";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import * as Y from "yjs";

import { SCORE_V0, zeroToOne } from "../../../packages/score-model/tests/fixtures/scoreV0";
import { buildApp } from "../src/app";
import { Score, ScoreMember, Version } from "../src/db/models";
import { AUTO_VERSIONS_KEPT, createVersion } from "../src/versions";
import { apiCall, createMembers, createScore, freshDatabase, freshRedis, listen, nextSyncStatus, type OpenScore, openScore, sessionOf, testConfig, ticketFor } from "./support";

const PASSWORD = "a password long enough";
const NO_SUCH_ID = "00000000-0000-4000-8000-000000000000";

let sequelize: Sequelize;
let redis: Redis;
let ids: Record<string, string>;
let apps: FastifyInstance[] = [];
let opened: OpenScore[] = [];

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  ids = await createMembers(["olivia", "eddie", "vera", "nora"], PASSWORD);
});

beforeEach(async () => {
  await redis.flushdb();
});

afterEach(async () => {
  for (const { provider } of opened) provider.destroy();
  for (const app of apps) await app.close();
  apps = [];
  opened = [];
});

afterAll(async () => {
  await redis.quit();
  await sequelize.close();
});

interface Started {
  app: FastifyInstance;
  sessions: Record<string, string>;
}

/** A new app, with a session of each account. */
async function startApp(migrations?: Parameters<typeof buildApp>[0]["migrations"]): Promise<Started> {
  const app = buildApp({ config: testConfig(), redis, logger: false, ...(migrations === undefined ? {} : { migrations }) });
  apps.push(app);
  await app.ready();
  const sessions: Record<string, string> = {};
  for (const username of Object.keys(ids)) sessions[username] = await sessionOf(app, username, PASSWORD);
  return { app, sessions };
}

/** A score olivia owns, eddie edits and vera views; nora is no member. */
async function scoreOfTheBand({ app, sessions }: Started, title = "版本測試"): Promise<string> {
  const id = await createScore(app, sessions.olivia!, title);
  await ScoreMember.bulkCreate([
    { scoreId: id, accountId: ids.eddie!, role: "editor" },
    { scoreId: id, accountId: ids.vera!, role: "viewer" },
  ]);
  return id;
}

/** The score as its row holds it. */
async function storedScore(scoreId: string) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await Score.findByPk(scoreId))!.docState);
  return docToJson(doc);
}

/** A version written straight into the table, `minutesAgo` old, holding `content` as it is. */
function writtenVersion(scoreId: string, content: unknown, { minutesAgo = 0, name = null, schemaVersion = SCHEMA_VERSION }: { minutesAgo?: number; name?: string | null; schemaVersion?: number } = {}) {
  const json = JSON.stringify(content);
  return Version.create({
    scoreId,
    schemaVersion,
    content: gzipSync(json),
    contentHash: `${minutesAgo}:${name}`.padEnd(64, "0").slice(0, 64),
    byteSize: Buffer.byteLength(json),
    reason: "interval",
    name,
    createdAt: new Date(Date.now() - minutesAgo * 60_000),
  });
}

test("every member lists the versions, the latest first, and reads one; an Owner and an Editor name one and make one; a Viewer is refused that, anyone else told there is none", async () => {
  const started = await startApp();
  const { app, sessions } = started;
  const id = await scoreOfTheBand(started);
  const score = await storedScore(id);
  const older = await writtenVersion(id, { ...score, title: "比較舊" }, { minutesAgo: 30 });
  const newer = await writtenVersion(id, { ...score, title: "比較新" }, { minutesAgo: 10 });
  const path = `/api/scores/${id}/versions`;

  for (const member of ["olivia", "eddie", "vera"]) {
    const listed = await apiCall(app, "GET", path, sessions[member]!);
    expect(listed.statusCode).toBe(200);
    const { versions } = versionList.parse(listed.json());
    expect(versions.map((version) => version.id)).toEqual([newer.id, older.id]);
    expect(versions[0]).toEqual({ id: newer.id, createdAt: newer.createdAt.toISOString(), reason: "interval", name: null, byteSize: newer.byteSize });
    const read = await apiCall(app, "GET", `${path}/${older.id}`, sessions[member]!);
    expect(read.statusCode).toBe(200);
    expect(scoreSchema.parse(read.json()).title).toBe("比較舊");
  }

  // Naming: the Owner and the Editor; the Viewer is refused, whatever the body.
  for (const [member, name] of [
    ["olivia", "錄音版"],
    ["eddie", "  排練前  "],
  ] as const) {
    const named = await apiCall(app, "PATCH", `${path}/${older.id}`, sessions[member]!, { name });
    expect(named.statusCode).toBe(200);
    expect(versionSummary.parse(named.json())).toMatchObject({ id: older.id, name: name.trim() });
  }
  expect((await Version.findByPk(older.id))?.name).toBe("排練前");
  for (const body of [{ name: "檢視者取的名字" }, { name: 3 }]) {
    const refused = await apiCall(app, "PATCH", `${path}/${older.id}`, sessions.vera!, body);
    expect([refused.statusCode, refused.json()]).toEqual([403, { code: "forbidden" }]);
  }
  expect((await apiCall(app, "POST", path, sessions.vera!, { name: "檢視者存的" })).statusCode).toBe(403);
  expect((await Version.findByPk(older.id))?.name).toBe("排練前");

  // Making one now: a named one by either of them.
  for (const [member, name] of [
    ["olivia", "擁有者存的"],
    ["eddie", "編輯者存的"],
  ] as const) {
    const made = await apiCall(app, "POST", path, sessions[member]!, { name });
    expect(made.statusCode).toBe(201);
    const version = await Version.findByPk((made.json() as { versionId: string }).versionId);
    expect([version?.reason, version?.name, version?.createdBy]).toEqual(["manual", name, ids[member]]);
  }

  // Anyone who is no member: no such score, on every route, whatever the body.
  for (const [method, url, body] of [
    ["GET", path, undefined],
    ["GET", `${path}/${older.id}`, undefined],
    ["PATCH", `${path}/${older.id}`, { name: "外人取的" }],
    ["PATCH", `${path}/${older.id}`, { name: "" }],
    ["POST", path, { name: "外人存的" }],
  ] as const) {
    const refused = await apiCall(app, method, url, sessions.nora!, body);
    expect([refused.statusCode, refused.json()]).toEqual([404, { code: "not_found" }]);
  }
  expect((await apiCall(app, "GET", path, null)).statusCode).toBe(401);
  expect(await Version.count({ where: { scoreId: id } })).toBe(4);
});

test("a name is 1 to 100 characters once trimmed, null takes it away; a version of another score, or none, is not found", async () => {
  const started = await startApp();
  const { app, sessions } = started;
  const id = await scoreOfTheBand(started);
  const other = await scoreOfTheBand(started, "別的團譜");
  const score = await storedScore(id);
  const version = await writtenVersion(id, score);
  const elsewhere = await writtenVersion(other, await storedScore(other));
  const path = `/api/scores/${id}/versions`;

  for (const name of ["", "   ", "a".repeat(101), 5]) {
    expect((await apiCall(app, "PATCH", `${path}/${version.id}`, sessions.eddie!, { name })).statusCode).toBe(400);
    expect((await apiCall(app, "POST", path, sessions.eddie!, { name })).statusCode).toBe(400);
  }
  expect((await apiCall(app, "PATCH", `${path}/${version.id}`, sessions.eddie!, { name: "名".repeat(100) })).statusCode).toBe(200);
  const cleared = await apiCall(app, "PATCH", `${path}/${version.id}`, sessions.eddie!, { name: null });
  expect(versionSummary.parse(cleared.json()).name).toBeNull();
  expect((await Version.findByPk(version.id))?.name).toBeNull();

  for (const versionId of [elsewhere.id, NO_SUCH_ID, "not-a-uuid"]) {
    expect((await apiCall(app, "GET", `${path}/${versionId}`, sessions.vera!)).statusCode).toBe(404);
    expect((await apiCall(app, "PATCH", `${path}/${versionId}`, sessions.eddie!, { name: "找不到" })).statusCode).toBe(404);
  }
  expect((await Version.findByPk(elsewhere.id))?.name).toBeNull();
});

test("a version named, and one made with a name, outlive any number of automatic ones; without its name a version goes like the others", async () => {
  const started = await startApp();
  const { app, sessions } = started;
  const id = await scoreOfTheBand(started);
  const score = await storedScore(id);
  const path = `/api/scores/${id}/versions`;
  // The oldest version of all, named afterwards; one made with a name now; one named, then not.
  const oldest = await writtenVersion(id, { ...score, title: "最早的" }, { minutesAgo: 10_000 });
  expect((await apiCall(app, "PATCH", `${path}/${oldest.id}`, sessions.eddie!, { name: "第一次錄音" })).statusCode).toBe(200);
  const unnamed = await writtenVersion(id, { ...score, title: "取過名又拿掉" }, { minutesAgo: 9_000 });
  await apiCall(app, "PATCH", `${path}/${unnamed.id}`, sessions.eddie!, { name: "暫時的名字" });
  await apiCall(app, "PATCH", `${path}/${unnamed.id}`, sessions.eddie!, { name: null });
  const saved = ((await apiCall(app, "POST", path, sessions.olivia!, { name: "存下來的" })).json() as { versionId: string }).versionId;

  // 200 automatic versions more, then 1 beyond.
  for (let index = 0; index <= AUTO_VERSIONS_KEPT; index += 1) {
    expect((await createVersion(id, () => ({ ...score, title: `自動 ${index}` }), "interval"))?.created).toBe(true);
  }

  const kept = new Set((await Version.findAll({ where: { scoreId: id }, attributes: ["id"] })).map((version) => version.id));
  expect(kept.has(oldest.id)).toBe(true);
  expect(kept.has(saved)).toBe(true);
  expect(kept.has(unnamed.id)).toBe(false);
  expect(await Version.count({ where: { scoreId: id, name: null } })).toBe(AUTO_VERSIONS_KEPT);
  expect(kept.size).toBe(AUTO_VERSIONS_KEPT + 2);
});

test("a version of an older schema is read through the JSON migration; one that cannot be brought up to date is refused", async () => {
  const started = await startApp([zeroToOne]);
  const { app, sessions } = started;
  const id = await scoreOfTheBand(started);
  const old = await writtenVersion(id, SCORE_V0, { schemaVersion: 0 });

  const read = await apiCall(app, "GET", `/api/scores/${id}/versions/${old.id}`, sessions.vera!);
  expect(read.statusCode).toBe(200);
  const migrated = scoreSchema.parse(read.json());
  expect(migrated).toEqual(migrateJson(SCORE_V0, [zeroToOne]));
  expect(migrated.schemaVersion).toBe(SCHEMA_VERSION);
  expect(migrated.parts.map((part) => part.staves)).toEqual([[{ clef: "tab" }], [{ clef: "treble" }]]);

  // The same version on a server with no step from schema 0, a newer one, and damaged content.
  const withoutStep = await startApp([]);
  const newer = await writtenVersion(id, { ...(await storedScore(id)), schemaVersion: SCHEMA_VERSION + 1 }, { schemaVersion: SCHEMA_VERSION + 1 });
  const damaged = await Version.create({ scoreId: id, schemaVersion: SCHEMA_VERSION, content: Buffer.from("not gzip"), contentHash: "d".repeat(64), byteSize: 8, reason: "interval" });
  for (const [server, versionId] of [
    [withoutStep, old.id],
    [started, newer.id],
    [started, damaged.id],
  ] as const) {
    const refused = await apiCall(server.app, "GET", `/api/scores/${id}/versions/${versionId}`, server.sessions.vera!);
    expect([refused.statusCode, refused.json()]).toEqual([409, { code: "version_unreadable" }]);
  }
});

test("a version made now holds what the members have open, before it is stored; one without a name is the restore's, made only when the content changed", async () => {
  const started = await startApp();
  const { app, sessions } = started;
  const url = await listen(app);
  const id = await scoreOfTheBand(started);
  const path = `/api/scores/${id}/versions`;

  // Nobody has the score open: the stored one is read, and not kept in memory afterwards.
  const first = await apiCall(app, "POST", path, sessions.eddie!);
  expect(first.statusCode).toBe(201);
  expect(app.collab.loadedScores()).toEqual([]);
  const firstVersion = await Version.findByPk((first.json() as { versionId: string }).versionId);
  expect([firstVersion?.reason, firstVersion?.name, firstVersion?.createdBy]).toEqual(["before_restore", null, ids.eddie]);
  // Nothing changed since: the latest version is the one a restore would make.
  const again = await apiCall(app, "POST", path, sessions.eddie!);
  expect([again.statusCode, again.json()]).toEqual([200, { versionId: firstVersion!.id }]);

  const member = await openScore(url, id, () => ticketFor(app, id, sessions.olivia!));
  opened.push(member);
  const applied = nextSyncStatus(member.provider);
  metaOf(member.doc).set("title", "剛改的標題");
  expect(await applied).toBe(true);
  // Stored 2 seconds after the change: not yet.
  const named = await apiCall(app, "POST", path, sessions.olivia!, { name: "改標題之後" });
  expect(named.statusCode).toBe(201);
  const read = await apiCall(app, "GET", `${path}/${(named.json() as { versionId: string }).versionId}`, sessions.vera!);
  expect(scoreSchema.parse(read.json())).toEqual(docToJson(member.doc));
  // A named one is made even when the latest one holds the same.
  expect((await apiCall(app, "POST", path, sessions.olivia!, { name: "同樣的內容" })).statusCode).toBe(201);
  expect(app.collab.loadedScores()).toEqual([id]);
});

test("a score this server cannot read gets no version made now: it says the score is read-only", async () => {
  const started = await startApp();
  const { app, sessions } = started;
  const id = await scoreOfTheBand(started);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await Score.findByPk(id))!.docState);
  metaOf(doc).set("schemaVersion", SCHEMA_VERSION + 1);
  await Score.update({ docState: Buffer.from(Y.encodeStateAsUpdate(doc)), schemaVersion: SCHEMA_VERSION + 1 }, { where: { id } });

  for (const body of [{ name: "存不了" }, undefined]) {
    const refused = await apiCall(app, "POST", `/api/scores/${id}/versions`, sessions.olivia!, body);
    expect([refused.statusCode, refused.json()]).toEqual([409, { code: "score_read_only" }]);
  }
  expect(await Version.count({ where: { scoreId: id } })).toBe(0);
});

test("a deleted score's versions are no one's to see", async () => {
  const started = await startApp();
  const { app, sessions } = started;
  const id = await scoreOfTheBand(started);
  const version = await writtenVersion(id, await storedScore(id));
  await Score.update({ deletedAt: new Date() }, { where: { id } });

  for (const [method, url, body] of [
    ["GET", `/api/scores/${id}/versions`, undefined],
    ["GET", `/api/scores/${id}/versions/${version.id}`, undefined],
    ["PATCH", `/api/scores/${id}/versions/${version.id}`, { name: "刪除後" }],
    ["POST", `/api/scores/${id}/versions`, { name: "刪除後" }],
  ] as const) {
    expect((await apiCall(app, method, url, sessions.olivia!, body)).statusCode).toBe(404);
  }
});
