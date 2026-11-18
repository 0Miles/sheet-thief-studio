// The scores API: creating a score, listing mine, opening one, and the collab ticket
// (docs/spec/routes.md, 3.3; docs/spec/security.md, section 8).
import { docToJson, type ScoreJSON } from "@studio/score-model";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import * as Y from "yjs";

import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import { Score, ScoreMember } from "../src/db/models";
import { holdClock } from "./clock";
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

afterEach(() => {
  vi.restoreAllMocks();
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

test("a member's collab tickets are limited to 60 a minute for one account, whatever the score", async () => {
  holdClock();
  const id = await createScore(app, anna);
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 59; attempt += 1) statuses.push((await askTicket(app, id, anna)).statusCode);
  // A score that is not theirs counts as well.
  statuses.push((await askTicket(app, "not-a-score", anna)).statusCode);
  expect(statuses).toEqual([...Array.from({ length: 59 }, () => 200), 404]);
  const over = await askTicket(app, id, anna);
  expect([over.statusCode, over.json()]).toEqual([429, { code: "rate_limited" }]);
  expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
  expect(Number(over.headers["retry-after"])).toBeLessThanOrEqual(60);
  // Another session of the same account is held back too; another account is not.
  expect((await askTicket(app, id, await sessionOf(app, "anna", PASSWORD))).statusCode).toBe(429);
  await ScoreMember.create({ scoreId: id, accountId: benId, role: "viewer" });
  expect((await askTicket(app, id, ben)).statusCode).toBe(200);
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
    // Two guitars in Drop tuning, drums and keys.
    parts: [{ preset: "guitar6", count: 2, tuning: [64, 59, 55, 50, 45, 38] }, { preset: "drums" }, { preset: "keys", count: 1 }],
    timeSig: { numerator: 6, denominator: 8 },
    tempo: 96,
  });
  const score = await storedContent(response);

  expect(score.title).toBe("新歌");
  expect(score.parts.map(({ name, kind, tuning, capo, staves, program }) => ({ name, kind, tuning, capo, staves, program }))).toEqual([
    { name: "吉他 1", kind: "fretted", tuning: [64, 59, 55, 50, 45, 38], capo: 0, staves: [{ clef: "tab" }], program: 25 },
    { name: "吉他 2", kind: "fretted", tuning: [64, 59, 55, 50, 45, 38], capo: 0, staves: [{ clef: "tab" }], program: 25 },
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
  // The most a score can have: fifteen parts besides drums, and drums.
  await storedContent(await create({ title: "滿了", parts: [{ preset: "guitar6", count: 14 }, { preset: "vocals" }, { preset: "drums" }] }));
  await sequelize.query("TRUNCATE scores CASCADE");
  const made = vi.spyOn(Score, "create");

  for (const parts of [
    [],
    // Seventeen parts.
    [{ preset: "guitar6", count: 15 }, { preset: "drums", count: 2 }],
    Array(17).fill({ preset: "drums" }),
    // Sixteen parts other than drums.
    [{ preset: "guitar6", count: 16 }],
    [{ preset: "guitar6", count: 15 }, { preset: "keys" }],
    [{ preset: "guitar6", count: 0 }],
    [{ preset: "guitar6", count: 1.5 }],
    // Counts far past the limit are refused as they are, without making that many parts first.
    [{ preset: "guitar6", count: 1e10 }],
    [{ preset: "guitar6", count: 1e7 }],
    [{ preset: "drums", count: -1e7 }, { preset: "guitar6", count: 1e7 }],
    [{ preset: "guitar6", tuning: [43, 38, 33, 28] }],
    [{ preset: "bass4", tuning: [43, 38, 33, 128] }],
    [{ preset: "bass4", tuning: [43, 38, 33, 27.5] }],
    [{ preset: "drums", tuning: [40] }],
    [{ preset: "keys", tuning: [] }],
    [{ preset: "banjo" }],
  ]) {
    const response = await create({ title: "測試團譜", parts });
    expect([response.statusCode, response.json().code]).toEqual([400, "invalid_request"]);
  }
  // Refused before the database is asked for anything.
  expect(made).not.toHaveBeenCalled();
});

test("a score needs a title of 1 to 100 characters, a time signature, a tempo and a number of bars in the ranges of the schema, and a request from our origin", async () => {
  const made = vi.spyOn(Score, "create");
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
    { title: "測試團譜", bars: 0 },
    { title: "測試團譜", bars: 1001 },
  ]) {
    const response = await create(payload);
    expect([response.statusCode, response.json().code]).toEqual([400, "invalid_request"]);
  }
  expect((await create({ title: "測試團譜" }, "https://elsewhere.example")).statusCode).toBe(403);
  // Refused before the database is asked for anything.
  expect(made).not.toHaveBeenCalled();
  // Any tempo of the range, not only whole ones.
  expect((await storedContent(await create({ title: "測試團譜", tempo: 92.5 }))).bars[0]?.tempo).toBe(92.5);
  // The longest title there may be, and more bars than the dialog's eight.
  const longest = await storedContent(await create({ title: "x".repeat(100), bars: 12 }));
  expect([longest.title, longest.bars.length]).toEqual(["x".repeat(100), 12]);
});
