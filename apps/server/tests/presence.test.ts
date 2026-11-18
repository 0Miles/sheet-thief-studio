// The presence through real providers (docs/spec/views.md, section 8; docs/spec/collab.md,
// section 5; ADR 0005): what the other members receive is the state the server rebuilt, its
// identity the connection's, whatever a tab sent; and no tab speaks for another.
import { createRequire } from "node:module";

import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import * as Y from "yjs";

import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import { ScoreMember } from "../src/db/models";
import { colorOf } from "../src/presence";
import { COOKIE, createScore, freshDatabase, freshRedis, listen, type OpenScore, openScore, ORIGIN, sessionOf, testConfig, ticketFor } from "./support";

type Awareness = NonNullable<HocuspocusProvider["awareness"]>;

// y-protocols as the provider has it: not a dependency of the server's own.
const awarenessProtocol = createRequire(createRequire(import.meta.url).resolve("@hocuspocus/provider"))("y-protocols/awareness") as {
  Awareness: new (doc: Y.Doc) => Awareness;
  encodeAwarenessUpdate(awareness: Awareness, clients: number[]): Uint8Array;
  applyAwarenessUpdate(awareness: Awareness, update: Uint8Array, origin: unknown): void;
  removeAwarenessStates(awareness: Awareness, clients: number[], origin: unknown): void;
};

const PASSWORD = "a password long enough";

let sequelize: Sequelize;
let redis: Redis;
let apps: FastifyInstance[] = [];
let opened: OpenScore[] = [];
const ids: Record<string, string> = {};

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  for (const [username, displayName] of [
    ["anna", "安娜"],
    ["ben", "班"],
    ["cara", "卡拉"],
  ] as const) {
    ids[username] = (await createAccount({ username, displayName, password: PASSWORD, isAdmin: false, mustChangePassword: false })).id;
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

/** Anna's score, Ben an Editor of it and Cara a Viewer, each with a session. */
async function band(): Promise<{ app: FastifyInstance; url: string; id: string; sessions: Record<string, string> }> {
  const app = buildApp({ config: testConfig(), redis, logger: false });
  apps.push(app);
  const url = await listen(app);
  const sessions = { anna: await sessionOf(app, "anna", PASSWORD), ben: await sessionOf(app, "ben", PASSWORD), cara: await sessionOf(app, "cara", PASSWORD) };
  const id = await createScore(app, sessions.anna, "在場測試");
  await ScoreMember.create({ scoreId: id, accountId: ids.ben!, role: "editor" });
  await ScoreMember.create({ scoreId: id, accountId: ids.cara!, role: "viewer" });
  return { app, url, id, sessions };
}

async function open(app: FastifyInstance, url: string, id: string, session: string): Promise<OpenScore> {
  const score = await openScore(url, id, () => ticketFor(app, id, session));
  opened.push(score);
  return score;
}

/** Resolves with the state the provider holds for this client once it passes the check. */
function stateOf(provider: HocuspocusProvider, clientId: number, check: (state: Record<string, unknown>) => boolean = () => true): Promise<Record<string, unknown>> {
  const awareness = provider.awareness!;
  return new Promise((resolve) => {
    const look = () => {
      const state = awareness.getStates().get(clientId) as Record<string, unknown> | undefined;
      if (state === undefined || !check(state)) return;
      awareness.off("change", look);
      resolve(state);
    };
    awareness.on("change", look);
    look();
  });
}

const CURSOR = { partId: "p1", barId: "b1", voice: "0:0", beatId: null, at: "after", line: 1 };

test("a state with a forged identity reaches the others with the server's: the account, its display name and its colour", async () => {
  const { app, url, id, sessions } = await band();
  const anna = await open(app, url, id, sessions.anna);
  const ben = await open(app, url, id, sessions.ben);
  anna.provider.awareness!.setLocalState({ accountId: ids.ben, displayName: "班", color: "#000000", mode: "edit", cursor: CURSOR, selection: null, extra: "x".repeat(1000) });

  const seen = await stateOf(ben.provider, anna.doc.clientID, (state) => state.cursor !== null);
  expect(seen).toEqual({ accountId: ids.anna, displayName: "安娜", color: colorOf(ids.anna!), mode: "edit", cursor: CURSOR, selection: null });
  // A tab that comes in later is sent the same, rebuilt state.
  const later = await open(app, url, id, sessions.cara);
  expect(await stateOf(later.provider, anna.doc.clientID)).toEqual(seen);
});

test("a Viewer is in the presence in read mode, whatever their tab says", async () => {
  const { app, url, id, sessions } = await band();
  const anna = await open(app, url, id, sessions.anna);
  const cara = await open(app, url, id, sessions.cara);
  cara.provider.awareness!.setLocalState({ mode: "edit", cursor: CURSOR, selection: null });
  expect(await stateOf(anna.provider, cara.doc.clientID, (state) => state.cursor !== null)).toEqual({
    accountId: ids.cara,
    displayName: "卡拉",
    color: colorOf(ids.cara!),
    mode: "read",
    cursor: CURSOR,
    selection: null,
  });
});

test("a tab cannot change or remove another tab's state", async () => {
  const { app, url, id, sessions } = await band();
  const anna = await open(app, url, id, sessions.anna);
  const ben = await open(app, url, id, sessions.ben);
  const cara = await open(app, url, id, sessions.cara);
  anna.provider.awareness!.setLocalState({ mode: "edit", cursor: CURSOR, selection: null });
  await stateOf(cara.provider, anna.doc.clientID, (state) => state.cursor !== null);

  // Ben's tab sends a newer state of Anna's client, then its removal: its provider passes on any
  // change of its awareness that it did not receive from the server.
  const forger = new Y.Doc();
  forger.clientID = anna.doc.clientID;
  const forged = new awarenessProtocol.Awareness(forger);
  for (let clock = 0; clock < 20; clock++) forged.setLocalState({ mode: "edit", cursor: { ...CURSOR, barId: "b9" }, selection: null });
  awarenessProtocol.applyAwarenessUpdate(ben.provider.awareness!, awarenessProtocol.encodeAwarenessUpdate(forged, [forger.clientID]), "forged");
  awarenessProtocol.removeAwarenessStates(ben.provider.awareness!, [anna.doc.clientID], "forged");
  forged.destroy();
  // Then a state of its own: once Cara has it, the server has handled what came before it.
  ben.provider.awareness!.setLocalState({ mode: "edit", cursor: { ...CURSOR, barId: "b2" }, selection: null });
  await stateOf(cara.provider, ben.doc.clientID, (state) => (state.cursor as { barId?: string } | null)?.barId === "b2");

  expect(cara.provider.awareness!.getStates().get(anna.doc.clientID)).toMatchObject({ accountId: ids.anna, cursor: CURSOR });
});

test("a display name changed while the score is open is in the member's next state", async () => {
  const { app, url, id, sessions } = await band();
  const anna = await open(app, url, id, sessions.anna);
  const ben = await open(app, url, id, sessions.ben);
  anna.provider.awareness!.setLocalState({ mode: "edit", cursor: null, selection: null });
  await stateOf(ben.provider, anna.doc.clientID, (state) => state.displayName === "安娜");

  const renamed = await app.inject({ method: "PATCH", url: "/api/me", headers: { origin: ORIGIN }, cookies: { [COOKIE]: sessions.anna }, payload: { displayName: "安娜二號" } });
  expect(renamed.statusCode).toBe(200);
  anna.provider.awareness!.setLocalStateField("cursor", CURSOR);
  expect(await stateOf(ben.provider, anna.doc.clientID, (state) => state.cursor !== null)).toMatchObject({ displayName: "安娜二號", cursor: CURSOR });
});

test("a tab that leaves takes its state with it", async () => {
  const { app, url, id, sessions } = await band();
  const anna = await open(app, url, id, sessions.anna);
  const ben = await open(app, url, id, sessions.ben);
  anna.provider.awareness!.setLocalState({ mode: "edit", cursor: CURSOR, selection: null });
  await stateOf(ben.provider, anna.doc.clientID, (state) => state.cursor !== null);
  opened = opened.filter((score) => score !== anna);
  anna.provider.destroy();
  await expect.poll(() => ben.provider.awareness!.getStates().has(anna.doc.clientID)).toBe(false);
});
