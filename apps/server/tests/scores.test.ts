// The scores API: creating a score, listing mine, opening one, and the collab ticket
// (docs/spec/routes.md, 3.3; docs/spec/security.md, section 8).
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

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

test("a score needs a title of 1 to 100 characters, and a request from our origin", async () => {
  const create = (payload: unknown, origin = ORIGIN) => app.inject({ method: "POST", url: "/api/scores", headers: { origin }, cookies: { [COOKIE]: anna }, payload: payload as object });
  for (const payload of [{}, { title: "" }, { title: "   " }, { title: "x".repeat(101) }]) {
    const response = await create(payload);
    expect([response.statusCode, response.json().code]).toEqual([400, "invalid_request"]);
  }
  expect((await create({ title: "測試團譜" }, "https://elsewhere.example")).statusCode).toBe(403);
  expect(await Score.count()).toBe(0);
});
