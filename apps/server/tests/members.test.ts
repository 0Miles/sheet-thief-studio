// Members (docs/spec/accounts.md, sections 3 to 6 and 9; docs/spec/routes.md, 3.3 and 3.4): the
// Owner adds accounts, changes roles, removes members and hands the score over; the others leave;
// and whoever loses a role loses the connections opened with it, through real providers.
import { Forbidden } from "@hocuspocus/common";
import { metaOf } from "@studio/score-model";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";

import { createAccount, setDisabled } from "../src/accounts";
import { buildApp } from "../src/app";
import { ScoreMember } from "../src/db/models";
import { askTicket, closes, COOKIE, createScore, freshDatabase, freshRedis, insync, listen, nextSyncStatus, type OpenScore, openScore, ORIGIN, sessionOf, socketClosed, testConfig, ticketFor } from "./support";

const PASSWORD = "a password long enough";

let sequelize: Sequelize;
let redis: Redis;
let apps: FastifyInstance[] = [];
let opened: OpenScore[] = [];
/** Account ids by username. */
const ids: Record<string, string> = {};

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  for (const username of ["anna", "ben", "cara", "dan", "eve"]) {
    ids[username] = (await createAccount({ username, displayName: `${username} 的名字`, password: PASSWORD, isAdmin: false, mustChangePassword: false })).id;
  }
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

async function startApp(): Promise<{ app: FastifyInstance; url: string }> {
  const app = buildApp({ config: testConfig(), redis, logger: false });
  apps.push(app);
  return { app, url: await listen(app) };
}

/** A call of the API as the settings page makes it, on a path under `/api/scores/`. */
function call(app: FastifyInstance, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, session: string | null, payload?: object) {
  return app.inject({
    method,
    url: `/api/scores/${path}`,
    headers: { origin: ORIGIN },
    ...(session === null ? {} : { cookies: { [COOKIE]: session } }),
    ...(payload === undefined ? {} : { payload }),
  });
}

/** A score of Anna's with her session, and a session of each account given a role in it. */
async function annasScore(app: FastifyInstance, members: Record<string, "editor" | "viewer"> = {}) {
  const anna = await sessionOf(app, "anna", PASSWORD);
  const session: Record<string, string> = {};
  const id = await createScore(app, anna, "成員測試");
  for (const [username, role] of Object.entries(members)) {
    expect((await call(app, "POST", `${id}/members`, anna, { username, role })).statusCode).toBe(201);
    session[username] = await sessionOf(app, username, PASSWORD);
  }
  return { id, session: { ...session, anna } as Record<string, string> & { anna: string } };
}

async function rolesOf(app: FastifyInstance, scoreId: string, session: string): Promise<Record<string, string>> {
  const response = await call(app, "GET", `${scoreId}/members`, session);
  expect(response.statusCode).toBe(200);
  return Object.fromEntries((response.json() as { members: { username: string; role: string }[] }).members.map(({ username, role }) => [username, role]));
}

async function open(app: FastifyInstance, url: string, scoreId: string, session: string): Promise<OpenScore> {
  const score = await openScore(url, scoreId, () => ticketFor(app, scoreId, session));
  opened.push(score);
  return score;
}

/** Whether the server applies a change the provider sends now. */
async function canChange(score: OpenScore, title: string): Promise<boolean> {
  const answer = nextSyncStatus(score.provider);
  metaOf(score.doc).set("title", title);
  return answer;
}

test("the Owner adds an account by its whole username, as an Editor unless told otherwise; every member reads the list", async () => {
  const { app } = await startApp();
  const { id, session } = await annasScore(app);

  const added = await call(app, "POST", `${id}/members`, session.anna, { username: "ben" });
  expect(added.statusCode).toBe(201);
  expect(added.json()).toEqual({ accountId: ids.ben, username: "ben", displayName: "ben 的名字", role: "editor", disabled: false });
  expect((await call(app, "POST", `${id}/members`, session.anna, { username: "cara", role: "viewer" })).json()).toMatchObject({ username: "cara", role: "viewer" });
  // A disabled account can be added; the list says it is disabled.
  await setDisabled(ids.eve!, true);
  expect((await call(app, "POST", `${id}/members`, session.anna, { username: "eve", role: "viewer" })).json()).toMatchObject({ username: "eve", disabled: true });
  await setDisabled(ids.eve!, false);

  const list = {
    members: [
      expect.objectContaining({ username: "anna", role: "owner" }),
      expect.objectContaining({ username: "ben", role: "editor" }),
      expect.objectContaining({ username: "cara", role: "viewer" }),
      expect.objectContaining({ username: "eve" }),
    ],
  };
  for (const username of ["anna", "ben", "cara"]) {
    const response = await call(app, "GET", `${id}/members`, await sessionOf(app, username, PASSWORD));
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(list);
  }
  // The score is now among Ben's.
  const mine = await app.inject({ method: "GET", url: "/api/scores", cookies: { [COOKIE]: await sessionOf(app, "ben", PASSWORD) } });
  expect(mine.json()).toMatchObject({ scores: [{ id, role: "editor" }] });
});

test("adding an account that does not exist, one that is a member already, or oneself is refused", async () => {
  const { app } = await startApp();
  const { id, session } = await annasScore(app, { ben: "editor" });

  const unknown = await call(app, "POST", `${id}/members`, session.anna, { username: "nobody" });
  expect([unknown.statusCode, unknown.json()]).toEqual([404, { code: "account_not_found" }]);
  // A name no account can have is no account either.
  expect((await call(app, "POST", `${id}/members`, session.anna, { username: "No Such Name!" })).json()).toEqual({ code: "account_not_found" });
  const twice = await call(app, "POST", `${id}/members`, session.anna, { username: "ben", role: "viewer" });
  expect([twice.statusCode, twice.json()]).toEqual([409, { code: "already_member" }]);
  const self = await call(app, "POST", `${id}/members`, session.anna, { username: "anna" });
  expect([self.statusCode, self.json()]).toEqual([409, { code: "already_member" }]);
  expect((await call(app, "POST", `${id}/members`, session.anna, { username: "cara", role: "owner" })).statusCode).toBe(400);
  expect((await call(app, "POST", `${id}/members`, session.anna, {})).statusCode).toBe(400);

  expect(await rolesOf(app, id, session.anna)).toEqual({ anna: "owner", ben: "editor" });
});

test("an Owner's username lookups are limited to 20 in 15 minutes, whatever they find", async () => {
  const { app } = await startApp();
  const { id, session } = await annasScore(app);
  const bens = await sessionOf(app, "ben", PASSWORD);
  const other = await createScore(app, bens);

  const statuses: number[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    statuses.push((await call(app, "POST", `${id}/members`, session.anna, { username: attempt === 0 ? "cara" : `nobody-${attempt}` })).statusCode);
  }
  expect(statuses).toEqual([201, ...Array.from({ length: 19 }, () => 404)]);
  const over = await call(app, "POST", `${id}/members`, session.anna, { username: "dan" });
  expect([over.statusCode, over.json()]).toEqual([429, { code: "rate_limited" }]);
  expect(Number(over.headers["retry-after"])).toBeGreaterThan(0);
  expect(await rolesOf(app, id, session.anna)).toEqual({ anna: "owner", cara: "editor" });
  // Counted by account: on another score of hers too, and not against another Owner.
  expect((await call(app, "POST", `${await createScore(app, session.anna)}/members`, session.anna, { username: "dan" })).statusCode).toBe(429);
  expect((await call(app, "POST", `${other}/members`, bens, { username: "dan" })).statusCode).toBe(201);
});

test("only the Owner manages members: 403 to the other members, 404 to anyone else, 401 without a session", async () => {
  const { app } = await startApp();
  const { id, session } = await annasScore(app, { ben: "editor", cara: "viewer" });
  const outsider = await sessionOf(app, "dan", PASSWORD);
  const managing = [
    ["POST", `${id}/members`, { username: "dan" }],
    ["PATCH", `${id}/members/${ids.cara}`, { role: "editor" }],
    ["DELETE", `${id}/members/${ids.cara}`, undefined],
    ["POST", `${id}/transfer`, { accountId: ids.ben }],
  ] as const;
  for (const [method, path, payload] of managing) {
    for (const member of ["ben", "cara"]) {
      const refused = await call(app, method, path, session[member]!, payload);
      expect([method, path, refused.statusCode, refused.json()]).toEqual([method, path, 403, { code: "forbidden" }]);
    }
    expect((await call(app, method, path, outsider, payload)).statusCode).toBe(404);
    expect((await call(app, method, path, null, payload)).statusCode).toBe(401);
  }
  // Neither the list nor leaving is there for anyone who is no member.
  expect((await call(app, "GET", `${id}/members`, outsider)).statusCode).toBe(404);
  expect((await call(app, "POST", `${id}/leave`, outsider)).statusCode).toBe(404);
  expect((await call(app, "GET", `${id}/members`, null)).statusCode).toBe(401);
  expect((await call(app, "GET", "not-a-score/members", session.anna)).statusCode).toBe(404);
  expect(await rolesOf(app, id, session.anna)).toEqual({ anna: "owner", ben: "editor", cara: "viewer" });
});

test("the Owner changes a member's role and removes members, but never the Owner", async () => {
  const { app } = await startApp();
  const { id, session } = await annasScore(app, { ben: "editor", cara: "viewer" });

  const changed = await call(app, "PATCH", `${id}/members/${ids.ben}`, session.anna, { role: "viewer" });
  expect([changed.statusCode, changed.json()]).toEqual([200, expect.objectContaining({ username: "ben", role: "viewer" })]);
  expect((await call(app, "PATCH", `${id}/members/${ids.cara}`, session.anna, { role: "editor" })).statusCode).toBe(200);
  expect(await rolesOf(app, id, session.anna)).toEqual({ anna: "owner", ben: "viewer", cara: "editor" });

  expect((await call(app, "PATCH", `${id}/members/${ids.ben}`, session.anna, { role: "owner" })).statusCode).toBe(400);
  expect((await call(app, "PATCH", `${id}/members/${ids.dan}`, session.anna, { role: "viewer" })).statusCode).toBe(404);
  expect((await call(app, "DELETE", `${id}/members/${ids.dan}`, session.anna)).statusCode).toBe(404);
  expect((await call(app, "DELETE", `${id}/members/not-an-id`, session.anna)).statusCode).toBe(404);
  const demoted = await call(app, "PATCH", `${id}/members/${ids.anna}`, session.anna, { role: "editor" });
  expect([demoted.statusCode, demoted.json()]).toEqual([409, { code: "owner_cannot_leave" }]);
  const removed = await call(app, "DELETE", `${id}/members/${ids.anna}`, session.anna);
  expect([removed.statusCode, removed.json()]).toEqual([409, { code: "owner_cannot_leave" }]);

  expect((await call(app, "DELETE", `${id}/members/${ids.ben}`, session.anna)).statusCode).toBe(204);
  expect(await rolesOf(app, id, session.anna)).toEqual({ anna: "owner", cara: "editor" });
  expect((await call(app, "GET", `${id}/members`, session.ben!)).statusCode).toBe(404);
});

test("an Editor and a Viewer leave; the Owner cannot", async () => {
  const { app } = await startApp();
  const { id, session } = await annasScore(app, { ben: "editor", cara: "viewer" });

  const owner = await call(app, "POST", `${id}/leave`, session.anna);
  expect([owner.statusCode, owner.json()]).toEqual([409, { code: "owner_cannot_leave" }]);
  for (const member of ["ben", "cara"]) {
    expect((await call(app, "POST", `${id}/leave`, session[member]!)).statusCode).toBe(204);
    expect((await call(app, "GET", id, session[member]!)).statusCode).toBe(404);
    expect((await call(app, "POST", `${id}/leave`, session[member]!)).statusCode).toBe(404);
  }
  expect(await rolesOf(app, id, session.anna)).toEqual({ anna: "owner" });
});

test("after a transfer the Owner of before is an Editor and the new Owner is the only one", async () => {
  const { app } = await startApp();
  const { id, session } = await annasScore(app, { ben: "viewer", cara: "editor" });

  // Only to another member, of an account that is not disabled.
  expect((await call(app, "POST", `${id}/transfer`, session.anna, { accountId: ids.dan })).statusCode).toBe(404);
  expect((await call(app, "POST", `${id}/transfer`, session.anna, { accountId: ids.anna })).statusCode).toBe(400);
  expect((await call(app, "POST", `${id}/transfer`, session.anna, {})).statusCode).toBe(400);
  await setDisabled(ids.ben!, true);
  expect((await call(app, "POST", `${id}/transfer`, session.anna, { accountId: ids.ben })).statusCode).toBe(400);
  await setDisabled(ids.ben!, false);
  expect(await rolesOf(app, id, session.anna)).toEqual({ anna: "owner", ben: "viewer", cara: "editor" });

  expect((await call(app, "POST", `${id}/transfer`, session.anna, { accountId: ids.ben })).statusCode).toBe(204);

  expect(await rolesOf(app, id, session.anna)).toEqual({ ben: "owner", anna: "editor", cara: "editor" });
  expect(await ScoreMember.count({ where: { scoreId: id, role: "owner" } })).toBe(1);
  expect((await call(app, "GET", id, session.anna)).json()).toMatchObject({ role: "editor", owner: { accountId: ids.ben } });
  // Anna manages nothing any more; Ben does.
  expect((await call(app, "POST", `${id}/transfer`, session.anna, { accountId: ids.cara })).statusCode).toBe(403);
  const bens = await sessionOf(app, "ben", PASSWORD);
  expect((await call(app, "DELETE", `${id}/members/${ids.anna}`, bens)).statusCode).toBe(204);
  expect(await rolesOf(app, id, bens)).toEqual({ ben: "owner", cara: "editor" });
});

test("an Editor made a Viewer is disconnected, and what it sends once back is dropped; nobody else's connection closes", async () => {
  const { app, url } = await startApp();
  const { id, session } = await annasScore(app, { ben: "editor", cara: "editor" });
  const anna = await open(app, url, id, session.anna);
  const ben = await open(app, url, id, session.ben!);
  const cara = await open(app, url, id, session.cara!);
  // Ben's connection to another score is not this score's business.
  const bensOwn = await open(app, url, await createScore(app, session.ben!), session.ben!);
  const others = [closes(anna), closes(cara), closes(bensOwn)];
  expect(await canChange(ben, "編輯者改的標題")).toBe(true);

  const closed = socketClosed(ben.provider);
  const back = insync(ben.provider);
  expect((await call(app, "PATCH", `${id}/members/${ids.ben}`, session.anna, { role: "viewer" })).statusCode).toBe(200);
  await closed;
  await back;

  expect((await askTicket(app, id, session.ben!)).json()).toMatchObject({ role: "viewer" });
  expect(await canChange(ben, "檢視者改的標題")).toBe(false);
  expect(await canChange(cara, "另一位編輯者改的標題")).toBe(true);
  expect(await canChange(anna, "擁有者改的標題")).toBe(true);
  expect(await canChange(bensOwn, "自己的團譜")).toBe(true);
  // What the Viewer wrote stays in its own document: it reached nobody (which of the others' titles won is theirs to settle).
  expect([metaOf(anna.doc).get("title"), metaOf(cara.doc).get("title")]).not.toContain("檢視者改的標題");
  expect(others.map((wasClosed) => wasClosed())).toEqual([false, false, false]);
});

test("a member removed, or who left, is disconnected and gets no ticket any more; the others stay", async () => {
  const { app, url } = await startApp();
  const { id, session } = await annasScore(app, { ben: "editor", cara: "viewer" });
  const anna = await open(app, url, id, session.anna);
  const annaClosed = closes(anna);

  for (const [member, leave] of [
    ["ben", () => call(app, "DELETE", `${id}/members/${ids.ben}`, session.anna)],
    ["cara", () => call(app, "POST", `${id}/leave`, session.cara!)],
  ] as const) {
    const gone = await open(app, url, id, session[member]!);
    const closed = socketClosed(gone.provider);
    expect((await leave()).statusCode).toBe(204);
    expect(await closed).toBe(Forbidden.code);
    const ticket = await askTicket(app, id, session[member]!);
    expect([ticket.statusCode, ticket.json()]).toEqual([404, { code: "not_found" }]);
    gone.provider.destroy();
  }
  expect(await canChange(anna, "擁有者改的標題")).toBe(true);
  expect(annaClosed()).toBe(false);
});

test("a transfer closes the connections of both, who come back with their new roles", async () => {
  const { app, url } = await startApp();
  const { id, session } = await annasScore(app, { ben: "viewer", cara: "editor" });
  const anna = await open(app, url, id, session.anna);
  const ben = await open(app, url, id, session.ben!);
  const cara = await open(app, url, id, session.cara!);
  const caraClosed = closes(cara);

  const closed = [socketClosed(anna.provider), socketClosed(ben.provider)];
  const back = [insync(anna.provider), insync(ben.provider)];
  expect((await call(app, "POST", `${id}/transfer`, session.anna, { accountId: ids.ben })).statusCode).toBe(204);
  await Promise.all(closed);
  await Promise.all(back);

  expect(await canChange(ben, "新擁有者改的標題")).toBe(true);
  expect(await canChange(anna, "原擁有者改的標題")).toBe(true);
  expect(caraClosed()).toBe(false);
});
