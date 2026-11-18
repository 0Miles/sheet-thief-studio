// Values nested deeper than a value of the document may be (#102, docs/spec/collab.md sections 2
// and 9): lib0's readAny decodes a value one call per level, and a member's browser that cannot
// decode an update breaks. The server lets none in and sends none to a member, a score stored
// with some written before there was a limit included.
import { ResetConnection } from "@hocuspocus/common";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { MessageType } from "@hocuspocus/server";
import { docToJson, metaOf, SCHEMA_VERSION, updateWithinDepth } from "@studio/score-model";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import * as encoding from "lib0/encoding";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "vitest";
import * as Y from "yjs";

import { deepUpdate, nested } from "../../../packages/score-model/tests/fixtures/deep";
import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import { Score } from "../src/db/models";
import { closes, createScore, freshDatabase, freshRedis, listen, nextSyncStatus, type OpenScore, openScore, sessionOf, socketClosed, testConfig, ticketFor } from "./support";

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
  url: string;
  session: string;
}

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

/** A sync message carrying `update` for the score, as a provider sends one, made by hand: Y would not encode or decode what it holds. */
function updateMessage(scoreId: string, update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarString(encoder, scoreId);
  encoding.writeVarUint(encoder, MessageType.Sync);
  // y-protocols' messageYjsUpdate.
  encoding.writeVarUint(encoder, 2);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** The document the score's row holds now. */
async function storedDoc(scoreId: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await Score.findByPk(scoreId))!.docState);
  return doc;
}

test("an update holding a value nested too deep, or one too deep to decode, closes the connection that sent it and reaches nobody", async () => {
  const started = await startApp();
  const id = await createScore(started.app, started.session);
  const other = await open(started, id);
  const otherClosed = closes(other);

  // 64 levels: a value like any other.
  const sender = await open(started, id);
  const applied = nextSyncStatus(sender.provider);
  metaOf(sender.doc).set("later", JSON.parse(nested(64)));
  expect(await applied).toBe(true);

  // 65: refused, the connection closed with ResetConnection.
  const closed = socketClosed(sender.provider);
  metaOf(sender.doc).set("deeper", JSON.parse(nested(65)));
  expect(await closed).toBe(ResetConnection.code);
  // Not left to reconnect and send it again.
  sender.provider.destroy();

  // Some thousands: lib0 cannot decode it, on the server either.
  const raw = await open(started, id);
  const rawClosed = socketClosed(raw.provider);
  raw.provider.configuration.websocketProvider.send(updateMessage(id, deepUpdate(100_000, "meta", "deepest")));
  expect(await rawClosed).toBe(ResetConnection.code);
  raw.provider.destroy();

  // The others got neither, and the server goes on.
  const still = nextSyncStatus(other.provider);
  metaOf(other.doc).set("title", "還在");
  expect(await still).toBe(true);
  expect(otherClosed()).toBe(false);
  for (const doc of [other.doc, (await open(started, id)).doc]) {
    expect(metaOf(doc).has("later")).toBe(true);
    expect([metaOf(doc).has("deeper"), metaOf(doc).has("deepest")]).toEqual([false, false]);
  }
});

/** Put values nested too deep in the score's row, as a server stored them before there was a limit: an object with one field too deep, and a list with one item too deep. */
async function storeTooDeep(scoreId: string, schemaVersion = SCHEMA_VERSION): Promise<Buffer> {
  const doc = await storedDoc(scoreId);
  metaOf(doc).set("schemaVersion", schemaVersion);
  metaOf(doc).set("later", JSON.parse(`{"kept":${nested(63)},"dropped":${nested(64)}}`));
  doc.getArray("elsewhere").push([1, JSON.parse(nested(70)), 2]);
  const docState = Buffer.from(Y.encodeStateAsUpdate(doc));
  expect(updateWithinDepth(docState)).toBe(false);
  await Score.update({ docState, schemaVersion }, { where: { id: scoreId } });
  return docState;
}

test("a score stored with values nested too deep reaches its members without them, and is stored so", async () => {
  const started = await startApp();
  const id = await createScore(started.app, started.session);
  await storeTooDeep(id);
  const { doc } = await open(started, id);
  expect(JSON.stringify(metaOf(doc).get("later"))).toBe(`{"kept":${nested(63)}}`);
  expect(doc.getArray("elsewhere").toJSON()).toEqual([1, 2]);
  expect(docToJson(doc).title).toBe("測試團譜");
  // Stored as it loaded, though no member changed anything.
  expect(updateWithinDepth((await Score.findByPk(id))!.docState)).toBe(true);
  expect(Y.encodeStateVector(await storedDoc(id))).toEqual(Y.encodeStateVector(doc));
});

test("a frozen score stored with values nested too deep reaches its members without them, and its row is not written", async () => {
  const started = await startApp();
  const id = await createScore(started.app, started.session);
  const state = await storeTooDeep(id, SCHEMA_VERSION + 1);
  const { doc } = await open(started, id);
  expect(JSON.stringify(metaOf(doc).get("later"))).toBe(`{"kept":${nested(63)}}`);
  expect(doc.getArray("elsewhere").toJSON()).toEqual([1, 2]);
  await started.app.close();
  expect((await Score.findByPk(id))!.docState).toEqual(state);
});

test("a score stored in a state the server cannot decode is not opened, and the server goes on", async () => {
  const started = await startApp();
  const broken = await createScore(started.app, started.session);
  const fine = await createScore(started.app, started.session);
  await Score.update({ docState: Buffer.from(deepUpdate(100_000, "meta", "deepest")) }, { where: { id: broken } });

  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({ url: started.url, name: broken, document: doc, token: () => ticketFor(started.app, broken, started.session) });
  opened.push({ provider, doc });
  const synced = await Promise.race([new Promise((resolve) => provider.on("synced", () => resolve(true))), new Promise((resolve) => setTimeout(() => resolve(false), 1500))]);
  expect(synced).toBe(false);
  expect(started.app.collab.loadedScores()).not.toContain(broken);
  expect(docToJson((await open(started, fine)).doc).title).toBe("測試團譜");
});
