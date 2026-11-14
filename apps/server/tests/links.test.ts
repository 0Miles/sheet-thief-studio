// Read-only links and their guests (docs/spec/accounts.md, section 7; docs/spec/collab.md,
// sections 3, 5 and 6): the Owner's API, the guest's ticket, and what a guest's connection may
// and may not do, through real providers.
import { Forbidden } from "@hocuspocus/common";
import { HocuspocusProvider, MessageType } from "@hocuspocus/provider";
import { docToJson, metaOf } from "@studio/score-model";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import * as decoding from "lib0/decoding";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import * as Y from "yjs";

import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import { Score, ScoreMember } from "../src/db/models";
import { withoutLinkTokens } from "../src/links";
import { closes, COOKIE, createScore, freshDatabase, freshRedis, insync, listen, nextSyncStatus, type OpenScore, openScore, ORIGIN, sessionOf, socketClosed, testConfig, ticketFor } from "./support";

const PASSWORD = "a password long enough";

let sequelize: Sequelize;
let redis: Redis;
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

async function startApp(): Promise<{ app: FastifyInstance; url: string }> {
  const app = buildApp({ config: testConfig(), redis, logger: false });
  apps.push(app);
  return { app, url: await listen(app) };
}

/** A score of Anna's, with her session. */
async function annasScore(app: FastifyInstance): Promise<{ id: string; session: string }> {
  const session = await sessionOf(app, "anna", PASSWORD);
  return { id: await createScore(app, session, "唯讀連結測試"), session };
}

/** The Owner's link API, as the settings page calls it. */
function link(app: FastifyInstance, method: "GET" | "POST" | "DELETE", scoreId: string, session: string) {
  return app.inject({ method, url: `/api/scores/${scoreId}/link`, headers: { origin: ORIGIN }, cookies: { [COOKIE]: session } });
}

async function makeLink(app: FastifyInstance, scoreId: string, session: string): Promise<string> {
  const response = await link(app, "POST", scoreId, session);
  if (response.statusCode !== 200) throw new Error(`making the link answered ${response.statusCode} ${response.body}`);
  return (response.json() as { token: string }).token;
}

/** What a guest's page asks with the link, without any cookie. */
function askAsGuest(app: FastifyInstance, token: string, remoteAddress?: string) {
  return app.inject({ method: "POST", url: `/api/s/${token}`, headers: { origin: ORIGIN }, remoteAddress });
}

async function guestTicketFor(app: FastifyInstance, token: string): Promise<string> {
  const response = await askAsGuest(app, token);
  if (response.statusCode !== 200) throw new Error(`the guest's ticket was refused: ${response.statusCode} ${response.body}`);
  return (response.json() as { ticket: string }).ticket;
}

async function openAsMember(app: FastifyInstance, url: string, scoreId: string, session: string): Promise<OpenScore> {
  const score = await openScore(url, scoreId, () => ticketFor(app, scoreId, session));
  opened.push(score);
  return score;
}

async function openAsGuest(app: FastifyInstance, url: string, scoreId: string, token: string): Promise<OpenScore> {
  const score = await openScore(url, scoreId, () => guestTicketFor(app, token));
  opened.push(score);
  return score;
}

/** Counts the awareness messages the provider receives from now on. */
function awarenessReceived(provider: HocuspocusProvider): () => number {
  let count = 0;
  provider.on("message", ({ message }: { message: { decoder: decoding.Decoder } }) => {
    decoding.readVarString(message.decoder);
    if (decoding.readVarUint(message.decoder) === MessageType.Awareness) count += 1;
  });
  return () => count;
}

/** Resolves once the provider's awareness holds a state for this client. */
function awarenessOf(provider: HocuspocusProvider, clientId: number): Promise<void> {
  const awareness = provider.awareness!;
  return new Promise((resolve) => {
    const check = () => {
      if (!awareness.getStates().has(clientId)) return;
      awareness.off("change", check);
      resolve();
    };
    awareness.on("change", check);
    check();
  });
}

test("a link token has at least 128 random bits; the Owner can read it again, and once made anew the old token answers 404", async () => {
  const { app } = await startApp();
  const { id, session } = await annasScore(app);
  expect((await link(app, "GET", id, session)).json()).toEqual({ token: null });

  const first = await makeLink(app, id, session);
  expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(Buffer.from(first, "base64url").length * 8).toBeGreaterThanOrEqual(128);
  expect((await link(app, "GET", id, session)).json()).toEqual({ token: first });
  const opened = await askAsGuest(app, first);
  expect(opened.statusCode).toBe(200);
  expect(opened.json()).toEqual({ scoreId: id, title: "唯讀連結測試", ticket: expect.any(String) });

  const second = await makeLink(app, id, session);
  expect(second).not.toBe(first);
  expect((await link(app, "GET", id, session)).json()).toEqual({ token: second });
  expect((await askAsGuest(app, first)).statusCode).toBe(404);
  expect((await askAsGuest(app, second)).statusCode).toBe(200);

  expect((await link(app, "DELETE", id, session)).statusCode).toBe(204);
  expect((await askAsGuest(app, second)).statusCode).toBe(404);
  expect((await link(app, "GET", id, session)).json()).toEqual({ token: null });
});

test("a wrong token answers 404; right and wrong answers both say no referrer and no index", async () => {
  const { app } = await startApp();
  const { id, session } = await annasScore(app);
  const token = await makeLink(app, id, session);
  const deleted = await annasScore(app);
  const deletedToken = await makeLink(app, deleted.id, deleted.session);
  await Score.update({ deletedAt: new Date() }, { where: { id: deleted.id } });

  const answers = [await askAsGuest(app, token), await askAsGuest(app, "x".repeat(43)), await askAsGuest(app, "not-a-token"), await askAsGuest(app, deletedToken)];
  expect(answers.map((answer) => answer.statusCode)).toEqual([200, 404, 404, 404]);
  for (const answer of answers) {
    expect(answer.headers["referrer-policy"]).toBe("no-referrer");
    expect(answer.headers["x-robots-tag"]).toBe("noindex");
  }
  // Refused by the Origin check, before any route: still both.
  const foreign = await app.inject({ method: "POST", url: `/api/s/${token}`, headers: { origin: "https://elsewhere.test" } });
  expect(foreign.statusCode).toBe(403);
  expect(foreign.headers["referrer-policy"]).toBe("no-referrer");
  expect(foreign.headers["x-robots-tag"]).toBe("noindex");
});

test("a guest's tickets are limited to 30 a minute from one IP", async () => {
  const { app } = await startApp();
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 30; attempt += 1) statuses.push((await askAsGuest(app, "x".repeat(43), "10.0.0.7")).statusCode);
  expect(statuses.every((status) => status === 404)).toBe(true);
  const over = await askAsGuest(app, "x".repeat(43), "10.0.0.7");
  expect(over.statusCode).toBe(429);
  expect(over.headers["retry-after"]).toBeDefined();
  // Another IP is not held back.
  expect((await askAsGuest(app, "x".repeat(43), "10.0.0.8")).statusCode).toBe(404);
});

test("only the Owner manages the link: 403 to another member, 404 to anyone else, 401 without a session", async () => {
  const { app } = await startApp();
  const { id } = await annasScore(app);
  await ScoreMember.create({ scoreId: id, accountId: ben, role: "editor" });
  const benSession = await sessionOf(app, "ben", PASSWORD);
  const outsider = await annasScore(app);
  for (const method of ["GET", "POST", "DELETE"] as const) {
    expect((await link(app, method, id, benSession)).statusCode).toBe(403);
    expect((await link(app, method, outsider.id, benSession)).statusCode).toBe(404);
    expect((await app.inject({ method, url: `/api/scores/${id}/link`, headers: { origin: ORIGIN } })).statusCode).toBe(401);
  }
});

test("what a guest's provider sends does not change the score", async () => {
  const { app, url } = await startApp();
  const { id, session } = await annasScore(app);
  const token = await makeLink(app, id, session);
  const before = docToJson((await openAsMember(app, url, id, session)).doc);

  const guest = await openAsGuest(app, url, id, token);
  expect(docToJson(guest.doc)).toEqual(before);
  const answer = nextSyncStatus(guest.provider);
  metaOf(guest.doc).set("title", "訪客改的標題");
  expect(await answer).toBe(false);

  expect(docToJson((await openAsMember(app, url, id, session)).doc)).toEqual(before);
  await app.close();
  const next = await startApp();
  expect(docToJson((await openAsMember(next.app, next.url, id, session)).doc)).toEqual(before);
});

test("a guest's awareness reaches no member, and no member's awareness reaches a guest", async () => {
  const { app, url } = await startApp();
  const { id, session } = await annasScore(app);
  const token = await makeLink(app, id, session);
  const anna = await openAsMember(app, url, id, session);
  anna.provider.awareness!.setLocalStateField("cursor", { bar: 1 });

  // The guest comes in after Anna's state is there (sent to each new connection), then states
  // its own, as a provider that sets one would.
  const guest = await openAsGuest(app, url, id, token);
  const toGuest = awarenessReceived(guest.provider);
  guest.provider.awareness!.setLocalStateField("cursor", { bar: 5 });

  // Anna again, in another tab, after both, with a state of her own: every state is sent to
  // this tab, and its own to everyone, so once the first tab has it, the guest has had every
  // chance to get it too.
  const tab = await openAsMember(app, url, id, await sessionOf(app, "anna", PASSWORD));
  tab.provider.awareness!.setLocalStateField("cursor", { bar: 3 });
  await awarenessOf(anna.provider, tab.doc.clientID);
  await awarenessOf(tab.provider, anna.doc.clientID);
  // And a change made after that reaches the guest after any awareness sent before it.
  const changed = new Promise<void>((resolve) => guest.doc.once("update", () => resolve()));
  metaOf(tab.doc).set("title", "之後改的標題");
  await changed;

  expect([...anna.provider.awareness!.getStates().keys()]).not.toContain(guest.doc.clientID);
  expect([...tab.provider.awareness!.getStates().keys()]).not.toContain(guest.doc.clientID);
  expect(toGuest()).toBe(0);
  expect([...guest.provider.awareness!.getStates().keys()]).toEqual([guest.doc.clientID]);
});

test("revoking the link, or making it anew, closes the guests' connections and leaves the members' open", async () => {
  const { app, url } = await startApp();
  const { id, session } = await annasScore(app);
  const member = await openAsMember(app, url, id, session);
  const memberClosed = closes(member);

  for (const replace of ["DELETE", "POST"] as const) {
    const token = await makeLink(app, id, session);
    const guest = await openAsGuest(app, url, id, token);
    const guestClosed = socketClosed(guest.provider);
    // Refused when it reconnects: its token opens nothing any more.
    const refused = new Promise<void>((resolve) => guest.provider.on("authenticationFailed", () => resolve()));

    expect((await link(app, replace, id, session)).statusCode).toBe(replace === "DELETE" ? 204 : 200);

    expect(await guestClosed).toBe(Forbidden.code);
    await refused;
  }
  const applied = nextSyncStatus(member.provider);
  metaOf(member.doc).set("title", "成員改的標題");
  expect(await applied).toBe(true);
  expect(memberClosed()).toBe(false);
});

test("a link revoked while a guest's document is being loaded leaves no connection of it open", async () => {
  const { app, url } = await startApp();
  const { id, session } = await annasScore(app);
  const token = await makeLink(app, id, session);
  const ticket = await guestTicketFor(app, token);
  // The ticket has passed onAuthenticate's checks; the link is revoked while the document comes
  // from Postgres, before the connection is in the register. The link's own lookup (scoreOfLink,
  // by its token) passes; the first other call of Score.findOne is loading the document
  // (liveScore in src/scores.ts): the spy stands in that window.
  const load = Score.findOne.bind(Score);
  let revoking: Promise<boolean> | null = null;
  vi.spyOn(Score, "findOne").mockImplementation(async (options) => {
    const lookup = typeof options?.where === "object" && "linkToken" in options.where;
    if (!lookup && revoking === null) {
      revoking = link(app, "DELETE", id, session).then((answer) => answer.statusCode === 204);
      await revoking;
    }
    return load(options);
  });

  const provider = new HocuspocusProvider({ url, name: id, document: new Y.Doc(), token: async () => ticket });
  opened.push({ provider, doc: provider.document });

  expect(await socketClosed(provider)).toBe(Forbidden.code);
  expect(await revoking).toBe(true);
  // Closed before it was sent the document: nothing of the score ever reached it.
  expect(provider.document.store.clients.size).toBe(0);
});

test("a member's connection still loading is closed by an event that concerns it, and only it", async () => {
  const { app, url } = await startApp();
  const { id, session } = await annasScore(app);
  const ticket = await ticketFor(app, id, session);
  const other = await annasScore(app);
  const load = Score.findOne.bind(Score);
  vi.spyOn(Score, "findOne").mockImplementationOnce(async (options) => {
    // Not this score's: nothing to close.
    expect(app.collab.closeConnections({ scoreId: other.id }, Forbidden)).toBe(0);
    expect(app.collab.closeConnections({ scoreId: id }, Forbidden)).toBe(1);
    return load(options);
  });

  const provider = new HocuspocusProvider({ url, name: id, document: new Y.Doc(), token: async () => ticket });
  opened.push({ provider, doc: provider.document });

  expect(await socketClosed(provider)).toBe(Forbidden.code);
  expect(provider.document.store.clients.size).toBe(0);
});

test("logs show no link token, in the path or in a parameter", () => {
  const token = "A".repeat(43);
  expect(withoutLinkTokens(`/api/s/${token}`)).toBe("/api/s/[token]");
  expect(withoutLinkTokens(`/s/${token}?x=1`)).toBe("/s/[token]?x=1");
  expect(withoutLinkTokens(`/%61pi/s/${token}`)).toBe("/api/s/[token]");
  expect(withoutLinkTokens(`/collab?token=${token}&a=b`)).toBe("/collab?token=[token]&a=b");
  expect(withoutLinkTokens("/api/scores")).toBe("/api/scores");
});

test("a guest whose link is still valid reconnects with a new ticket after the server closes its connection", async () => {
  const { app, url } = await startApp();
  const { id, session } = await annasScore(app);
  const token = await makeLink(app, id, session);
  const guest = await openAsGuest(app, url, id, token);
  const closed = socketClosed(guest.provider);

  expect(app.collab.closeConnections({ linkToken: token }, Forbidden)).toBe(1);

  expect(await closed).toBe(Forbidden.code);
  await insync(guest.provider);
});
