// What members do with a score's versions (docs/spec/routes.md, 3.6; docs/spec/collab.md, 8.4
// to 8.6): every member lists and reads them, brought to the current schema; an Owner or an
// Editor names one, and makes a named one now; anyone else is told there is no such score.
import { gunzipSync, gzipSync } from "node:zlib";

import { versionList, versionSummary } from "@studio/contracts";
import { docToJson, metaOf, migrateJson, SCHEMA_VERSION, scoreSchema } from "@studio/score-model";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
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

  // 200 automatic versions more, newer than those, written at once (one version made at a time
  // would make this test as slow as 200 transactions); then one made beyond them.
  const automatic = await Version.bulkCreate(
    Array.from({ length: AUTO_VERSIONS_KEPT }, (_, index) => ({
      scoreId: id,
      schemaVersion: SCHEMA_VERSION,
      content: Buffer.from("old"),
      contentHash: `${index}`.padStart(64, "0"),
      byteSize: 3,
      reason: "interval" as const,
      createdAt: new Date(Date.now() - (index + 1) * 60_000),
    })),
  );
  expect((await createVersion(id, { read: () => ({ ...score, title: "第 201 個" }), reason: "interval" }))?.created).toBe(true);

  // The two oldest automatic ones went: the one whose name was taken away, and the oldest written.
  const kept = new Set((await Version.findAll({ where: { scoreId: id }, attributes: ["id"] })).map((version) => version.id));
  expect(kept.has(oldest.id)).toBe(true);
  expect(kept.has(saved)).toBe(true);
  expect(kept.has(unnamed.id)).toBe(false);
  expect(kept.has(automatic.at(-1)!.id)).toBe(false);
  expect(kept.has(automatic.at(-2)!.id)).toBe(true);
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

test("a version made now holds what the score is on the server: the stored one when nobody has it open, the members' before it is stored; never without a name", async () => {
  const started = await startApp();
  const { app, sessions } = started;
  const url = await listen(app);
  const id = await scoreOfTheBand(started);
  const path = `/api/scores/${id}/versions`;

  // Without a name: the version a restore makes first, which is not made here (#68).
  for (const body of [undefined, {}, { name: null }]) expect((await apiCall(app, "POST", path, sessions.eddie!, body)).statusCode).toBe(400);
  expect(await Version.count({ where: { scoreId: id } })).toBe(0);

  // Nobody has the score open: the stored one is read, and not kept in memory afterwards.
  const first = await apiCall(app, "POST", path, sessions.eddie!, { name: "沒人開著時" });
  expect(first.statusCode).toBe(201);
  expect(app.collab.loadedScores()).toEqual([]);
  const firstVersion = await Version.findByPk((first.json() as { versionId: string }).versionId);
  expect([firstVersion?.reason, firstVersion?.name, firstVersion?.createdBy]).toEqual(["manual", "沒人開著時", ids.eddie]);
  expect(JSON.parse(gunzipSync(firstVersion!.content).toString())).toEqual(await storedScore(id));

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

  const refused = await apiCall(app, "POST", `/api/scores/${id}/versions`, sessions.olivia!, { name: "存不了" });
  expect([refused.statusCode, refused.json()]).toEqual([409, { code: "score_read_only" }]);
  expect(await Version.count({ where: { scoreId: id } })).toBe(0);
});

/**
 * Change the score after the request was let in and before its version is made, as another
 * request at once would: `Collab.saveVersion` is the step between the two. Deterministic, so no
 * warmed pool is needed: the change is committed before the version's transaction starts.
 */
function meanwhile(app: FastifyInstance, change: () => Promise<unknown>): void {
  const original = app.collab.saveVersion.bind(app.collab);
  vi.spyOn(app.collab, "saveVersion").mockImplementationOnce(async (...args) => {
    await change();
    return original(...args);
  });
}

test("an Editor made a Viewer while asking for a version gets none: the role is checked again once the score is locked", async () => {
  const started = await startApp();
  const { app, sessions } = started;
  const id = await scoreOfTheBand(started);
  meanwhile(app, () => ScoreMember.update({ role: "viewer" }, { where: { scoreId: id, accountId: ids.eddie! } }));

  const refused = await apiCall(app, "POST", `/api/scores/${id}/versions`, sessions.eddie!, { name: "降級前送出的" });

  expect([refused.statusCode, refused.json()]).toEqual([403, { code: "forbidden" }]);
  expect(await Version.count({ where: { scoreId: id } })).toBe(0);
});

test("a score deleted while a version of it is asked for gets none, whether members had it open or not", async () => {
  const started = await startApp();
  const { app, sessions } = started;
  const url = await listen(app);
  const deleted = () => new Date();

  // Nobody has it open: it would be loaded, and a deleted score is not.
  const closed = await scoreOfTheBand(started, "沒人開著");
  meanwhile(app, () => Score.update({ deletedAt: deleted() }, { where: { id: closed } }));
  const notLoaded = await apiCall(app, "POST", `/api/scores/${closed}/versions`, sessions.olivia!, { name: "刪除時存的" });
  expect([notLoaded.statusCode, notLoaded.json()]).toEqual([404, { code: "not_found" }]);
  expect(await Version.count({ where: { scoreId: closed } })).toBe(0);

  // A member has it open: it is in memory, and the version is refused once its row is locked.
  const open = await scoreOfTheBand(started, "有人開著");
  opened.push(await openScore(url, open, () => ticketFor(app, open, sessions.eddie!)));
  meanwhile(app, () => Score.update({ deletedAt: deleted() }, { where: { id: open } }));
  const loaded = await apiCall(app, "POST", `/api/scores/${open}/versions`, sessions.olivia!, { name: "刪除時存的" });
  expect([loaded.statusCode, loaded.json()]).toEqual([404, { code: "not_found" }]);
  expect(await Version.count({ where: { scoreId: open } })).toBe(0);
});

test("a member's own version keeps a name: renamed, never unnamed", async () => {
  const started = await startApp();
  const { app, sessions } = started;
  const id = await scoreOfTheBand(started);
  const path = `/api/scores/${id}/versions`;
  const versionId = ((await apiCall(app, "POST", path, sessions.eddie!, { name: "手動存的" })).json() as { versionId: string }).versionId;

  const refused = await apiCall(app, "PATCH", `${path}/${versionId}`, sessions.olivia!, { name: null });
  expect([refused.statusCode, refused.json()]).toEqual([409, { code: "version_name_required" }]);
  expect((await Version.findByPk(versionId))?.name).toBe("手動存的");
  expect((await apiCall(app, "PATCH", `${path}/${versionId}`, sessions.olivia!, { name: "改過名" })).statusCode).toBe(200);
  expect((await Version.findByPk(versionId))?.name).toBe("改過名");
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
