// The scores API: creating a score, listing mine, opening one, and the collab ticket
// (docs/spec/routes.md, 3.3; docs/spec/security.md, section 8).
import { docToJson, type ScoreJSON } from "@studio/score-model";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import * as Y from "yjs";

import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import { Score, ScoreMember } from "../src/db/models";
import { askTicket, COOKIE, createScore, freshDatabase, freshRedis, ORIGIN, sessionOf, testConfig } from "./support";

const PASSWORD = "a password long enough";

let sequelize: Sequelize;
let redis: Redis;
let app: FastifyInstance;
let annaId: string;
let anna: string;
let benId: string;
let ben: string;

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  app = buildApp({ config: testConfig(), redis, logger: false });
  const account = (username: string, displayName: string) => createAccount({ username, displayName, password: PASSWORD, isAdmin: false, mustChangePassword: false });
  annaId = (await account("anna", "安娜")).id;
  benId = (await account("ben", "班")).id;
});

beforeEach(async () => {
  await redis.flushdb();
  await sequelize.query("TRUNCATE scores CASCADE");
  anna = await sessionOf(app, "anna", PASSWORD);
  ben = await sessionOf(app, "ben", PASSWORD);
});

afterAll(async () => {
  await app.close();
  await redis.quit();
  await sequelize.close();
});

function get(url: string, session: string) {
  return app.inject({ method: "GET", url, cookies: { [COOKIE]: session } });
}

test("anyone logged in creates a score and is its Owner; it is listed among their scores, most recently updated first", async () => {
  const older = await createScore(app, anna, "舊的");
  const newer = await createScore(app, anna, "新的");
  // The older score was changed last.
  await sequelize.query("UPDATE scores SET updated_at = now() + interval '1 minute' WHERE id = :id", { replacements: { id: older } });

  const response = await get("/api/scores", anna);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    scores: [
      { id: older, title: "舊的", artist: null, role: "owner", updatedAt: expect.any(String) },
      { id: newer, title: "新的", artist: null, role: "owner", updatedAt: expect.any(String) },
    ],
  });
  expect((await get("/api/scores", ben)).json()).toEqual({ scores: [] });
});

test("a score is opened by its members only; anyone else, and everyone once it is deleted, gets the same 404", async () => {
  const id = await createScore(app, anna, "測試團譜");
  await ScoreMember.create({ scoreId: id, accountId: benId, role: "viewer" });
  const owner = { accountId: annaId, displayName: "安娜" };

  expect((await get(`/api/scores/${id}`, anna)).json()).toEqual({ id, title: "測試團譜", artist: null, role: "owner", owner });
  expect((await get(`/api/scores/${id}`, ben)).json()).toEqual({ id, title: "測試團譜", artist: null, role: "viewer", owner });

  await ScoreMember.destroy({ where: { scoreId: id, role: "viewer" } });
  for (const response of [await get(`/api/scores/${id}`, ben), await askTicket(app, id, ben)]) {
    expect([response.statusCode, response.json()]).toEqual([404, { code: "not_found" }]);
  }
  await Score.update({ deletedAt: new Date() }, { where: { id } });
  for (const response of [await get(`/api/scores/${id}`, anna), await askTicket(app, id, anna), await get("/api/scores/not-a-score", anna)]) {
    expect([response.statusCode, response.json()]).toEqual([404, { code: "not_found" }]);
  }
  expect((await get("/api/scores", anna)).json()).toEqual({ scores: [] });
});

test("a member gets a collab ticket with their role", async () => {
  const id = await createScore(app, anna);
  const response = await askTicket(app, id, anna);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ ticket: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), role: "owner" });
  expect(response.json().ticket).not.toBe((await askTicket(app, id, anna)).json().ticket);
});

function create(payload: unknown, origin = ORIGIN) {
  return app.inject({ method: "POST", url: "/api/scores", headers: { origin }, cookies: { [COOKIE]: anna }, payload: payload as object });
}

/** The content the server stored for the score this answer made. */
async function storedContent(response: { statusCode: number; json: () => { id: string } }): Promise<ScoreJSON> {
  expect(response.statusCode).toBe(201);
  const score = await Score.findByPk(response.json().id);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, score!.docState);
  return docToJson(doc);
}

test("a score starts with the parts, time signature and tempo chosen in the dialog, its parts numbered by preset", async () => {
  const response = await create({
    title: "新歌",
    parts: [{ preset: "guitar6" }, { preset: "guitar7", tuning: [64, 59, 55, 50, 45, 40, 33] }, { preset: "drums" }, { preset: "keys" }],
    timeSig: { numerator: 6, denominator: 8 },
    tempo: 96,
  });
  const score = await storedContent(response);

  expect(score.title).toBe("新歌");
  expect(score.parts.map(({ name, kind, tuning, capo, staves, program }) => ({ name, kind, tuning, capo, staves, program }))).toEqual([
    { name: "吉他 1", kind: "fretted", tuning: [64, 59, 55, 50, 45, 40], capo: 0, staves: [{ clef: "tab" }], program: 25 },
    { name: "吉他 2", kind: "fretted", tuning: [64, 59, 55, 50, 45, 40, 33], capo: 0, staves: [{ clef: "tab" }], program: 25 },
    { name: "鼓 1", kind: "percussion", tuning: [], capo: 0, staves: [{ clef: "neutral" }], program: 0 },
    { name: "鍵盤 1", kind: "pitched", tuning: [], capo: 0, staves: [{ clef: "treble" }, { clef: "bass" }], program: 0 },
  ]);
  expect(score.bars).toHaveLength(8);
  expect(score.bars.map((bar) => bar.timeSig)).toEqual(Array(8).fill({ numerator: 6, denominator: 8 }));
  expect(score.bars.map((bar) => bar.tempo)).toEqual([96, ...Array(7).fill(undefined)]);
  // Every part has every bar, with every voice of its staves.
  for (const part of score.parts) {
    expect(Object.keys(part.content)).toEqual(score.bars.map((bar) => bar.id));
  }
});

test("a score asked for by its title only starts with the defaults: one six-string guitar, eight bars of 4/4 at 120", async () => {
  const score = await storedContent(await create({ title: "只有標題" }));
  expect(score.parts.map(({ name, kind, tuning }) => ({ name, kind, tuning }))).toEqual([{ name: "吉他 1", kind: "fretted", tuning: [64, 59, 55, 50, 45, 40] }]);
  expect(score.bars.map(({ timeSig, tempo }) => ({ timeSig, tempo }))).toEqual([{ timeSig: { numerator: 4, denominator: 4 }, tempo: 120 }, ...Array(7).fill({ timeSig: { numerator: 4, denominator: 4 } })]);
});

test("a score has 1 to 16 parts, at most 15 of them other than drums; a part a tuning of its own number of strings", async () => {
  const guitars = (count: number) => Array(count).fill({ preset: "guitar6" });
  // The most a score can have: fifteen parts besides drums, and drums.
  await storedContent(await create({ title: "滿了", parts: [...guitars(15), { preset: "drums" }] }));
  await sequelize.query("TRUNCATE scores CASCADE");

  for (const parts of [
    [],
    [...guitars(15), { preset: "drums" }, { preset: "drums" }],
    guitars(16),
    [{ preset: "guitar6", tuning: [43, 38, 33, 28] }],
    [{ preset: "bass4", tuning: [43, 38, 33, 128] }],
    [{ preset: "bass4", tuning: [43, 38, 33, 27.5] }],
    [{ preset: "drums", tuning: [40] }],
    [{ preset: "banjo" }],
  ]) {
    const response = await create({ title: "測試團譜", parts });
    expect([response.statusCode, response.json().code]).toEqual([400, "invalid_request"]);
  }
  expect(await Score.count()).toBe(0);
});

test("a score needs a title of 1 to 100 characters, a time signature and a tempo in the ranges of the schema, and a request from our origin", async () => {
  for (const payload of [
    {},
    { title: "" },
    { title: "   " },
    { title: "x".repeat(101) },
    { title: "測試團譜", timeSig: { numerator: 0, denominator: 4 } },
    { title: "測試團譜", timeSig: { numerator: 33, denominator: 4 } },
    { title: "測試團譜", timeSig: { numerator: 4, denominator: 3 } },
    { title: "測試團譜", tempo: 19 },
    { title: "測試團譜", tempo: 401 },
  ]) {
    const response = await create(payload);
    expect([response.statusCode, response.json().code]).toEqual([400, "invalid_request"]);
  }
  expect((await create({ title: "測試團譜" }, "https://elsewhere.example")).statusCode).toBe(403);
  expect(await Score.count()).toBe(0);
  // The longest title there may be.
  expect((await storedContent(await create({ title: "x".repeat(100) }))).title).toBe("x".repeat(100));
});
