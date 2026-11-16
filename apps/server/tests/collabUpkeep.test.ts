// What the collab server does to a score on its own (docs/spec/collab.md, sections 2 and 4;
// docs/spec/schema.md, sections 9 and 10): migrate it when it loads it, fill in the content two
// members left missing, and mirror its title and artist to the `scores` table when it stores it.
import { collabNotice, type CollabNotice } from "@studio/contracts";
import { addPart, barsOf, contentOf, docToJson, fillMissingContent, insertBars, metaOf, type Migration, partsOf, SCHEMA_VERSION, STANDARD_GUITAR } from "@studio/score-model";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import * as Y from "yjs";

import { docV0, zeroToOne } from "../../../packages/score-model/tests/fixtures/scoreV0";
import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import { FILL_DEBOUNCE_MS } from "../src/collab";
import { Score } from "../src/db/models";
import { createScore, freshDatabase, freshRedis, listen, nextSyncStatus, type OpenScore, openScore, sessionOf, testConfig, ticketFor } from "./support";

// The model as it is, with a fill that one test makes fail once.
vi.mock("@studio/score-model", async (original) => {
  const actual = await original<typeof import("@studio/score-model")>();
  return { ...actual, fillMissingContent: vi.fn(actual.fillMissingContent) };
});

const PASSWORD = "a password long enough";
/** The debounce of a store (docs/spec/collab.md, section 1). */
const STORE_DEBOUNCE_MS = 2000;

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
async function startApp(migrations?: readonly Migration[]): Promise<Started> {
  const app = buildApp({ config: testConfig(), redis, logger: false, ...(migrations ? { migrations } : {}) });
  apps.push(app);
  const url = await listen(app);
  return { app, url, session: await sessionOf(app, "anna", PASSWORD) };
}

/** Open the score as anna, collecting what the server tells this connection about the document. */
async function open({ app, url, session }: Started, scoreId: string): Promise<OpenScore & { notices: CollabNotice[] }> {
  const notices: CollabNotice[] = [];
  const score = await openScore(
    url,
    scoreId,
    () => ticketFor(app, scoreId, session),
    (payload) => notices.push(collabNotice.parse(JSON.parse(payload))),
  );
  opened.push(score);
  return { ...score, notices };
}

/** Put a document in the score's row as if an older or a newer server had stored it there. */
async function storeAs(scoreId: string, doc: Y.Doc, schemaVersion: number): Promise<Buffer> {
  const docState = Buffer.from(Y.encodeStateAsUpdate(doc));
  await Score.update({ docState, schemaVersion }, { where: { id: scoreId } });
  return docState;
}

/** How many times a document was stored since the call: every store writes `doc_state`. */
function countStores(): () => number {
  const update = vi.spyOn(Score, "update");
  return () => update.mock.calls.filter(([values]) => "docState" in values).length;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The document the score's row holds now. */
async function storedDoc(scoreId: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, (await Score.findByPk(scoreId))!.docState);
  return doc;
}

/** Leave the score, and wait until the server has let go of its document. */
async function leave(app: FastifyInstance, score: OpenScore): Promise<void> {
  score.provider.destroy();
  await expect.poll(() => app.collab.loadedScores()).toEqual([]);
}

/** Schema 0 to 1 that fails on every document, after it has changed something in it. */
const failing: Migration = {
  ...zeroToOne,
  doc(doc) {
    zeroToOne.doc(doc);
    throw new Error("a step that fails");
  },
};

/** For the tests that wait for the debounced fill and store, and then for nothing more to follow. */
const SLOW = 20_000;

test("a score stored in an older schema reaches the provider migrated to the current one", async () => {
  const started = await startApp([zeroToOne]);
  const id = await createScore(started.app, started.session);
  await storeAs(id, docV0(), 0);

  const { provider, doc } = await open(started, id);
  expect(metaOf(doc).get("schemaVersion")).toBe(SCHEMA_VERSION);
  const score = docToJson(doc);
  expect(score.title).toBe("Old");
  expect(score.parts.map((part) => part.staves)).toEqual([[{ clef: "tab" }], [{ clef: "treble" }]]);
  // Every voice of the staves the migration gave the parts is there too.
  for (const part of partsOf(doc).values()) for (const voices of contentOf(part).values()) expect([...voices.keys()].sort()).toEqual(["0:0", "0:1"]);

  // What loading changed is in the row already, though no member changed anything.
  expect((await Score.findByPk(id))!.schemaVersion).toBe(SCHEMA_VERSION);
  expect(docToJson(await storedDoc(id))).toEqual(score);
  expect(Y.encodeStateVector(await storedDoc(id))).toEqual(Y.encodeStateVector(doc));
  // So the next load has nothing to do again: no new operations, nothing stored.
  await leave(started.app, { provider, doc });
  const state = (await Score.findByPk(id))!.docState;
  const stores = countStores();
  const again = await open(started, id);
  expect(Y.encodeStateVector(again.doc)).toEqual(Y.encodeStateVector(doc));
  await leave(started.app, again);
  expect(stores()).toBe(0);
  expect((await Score.findByPk(id))!.docState).toEqual(state);
});

test("a migrated score is a score like any other: a member changes it, and the row follows", async () => {
  const started = await startApp([zeroToOne]);
  const id = await createScore(started.app, started.session);
  await storeAs(id, docV0(), 0);
  const { provider, doc, notices } = await open(started, id);
  const applied = nextSyncStatus(provider);
  metaOf(doc).set("title", "Migrated");
  expect(await applied).toBe(true);
  expect(notices).toEqual([]);
  await expect.poll(async () => (await Score.findByPk(id))!.title, { timeout: 2 * STORE_DEBOUNCE_MS }).toBe("Migrated");
});

/** A new score stored with the content of its second bar gone, and the second voice of its third. */
async function scoreWithGaps(started: Started): Promise<{ id: string; partId: string; bars: string[] }> {
  const id = await createScore(started.app, started.session);
  const doc = await storedDoc(id);
  const [partId] = [...partsOf(doc).keys()];
  const bars = [...barsOf(doc).keys()];
  const content = contentOf(partsOf(doc).get(partId!)!);
  doc.transact(() => {
    content.delete(bars[1]!);
    content.get(bars[2]!)!.delete("0:1");
  });
  await storeAs(id, doc, SCHEMA_VERSION);
  return { id, partId: partId!, bars };
}

test("a score stored with content missing is filled in as it is loaded, and stored at once", async () => {
  const started = await startApp();
  const { id, partId, bars } = await scoreWithGaps(started);
  const stores = countStores();

  const { provider, doc } = await open(started, id);
  const voicesOf = (from: Y.Doc) => bars.map((barId) => [...(contentOf(partsOf(from).get(partId)!).get(barId)?.keys() ?? [])].sort());
  expect(voicesOf(doc)).toEqual(bars.map(() => ["0:0", "0:1"]));
  expect(stores()).toBe(1);
  expect(voicesOf(await storedDoc(id))).toEqual(voicesOf(doc));
  expect(Y.encodeStateVector(await storedDoc(id))).toEqual(Y.encodeStateVector(doc));

  // Loaded again, nothing is missing: no new operations, nothing stored.
  await leave(started.app, { provider, doc });
  const again = await open(started, id);
  expect(Y.encodeStateVector(again.doc)).toEqual(Y.encodeStateVector(doc));
  await leave(started.app, again);
  expect(stores()).toBe(1);
});

test("a score whose content cannot be filled in as it is loaded opens all the same", async () => {
  const started = await startApp();
  const { id, partId, bars } = await scoreWithGaps(started);
  const stores = countStores();
  vi.mocked(fillMissingContent).mockImplementationOnce(() => {
    throw new Error("a fill that fails");
  });

  const { provider, doc } = await open(started, id);
  expect(vi.mocked(fillMissingContent).mock.results.at(-1)!.type).toBe("throw");
  expect(contentOf(partsOf(doc).get(partId)!).has(bars[1]!)).toBe(false);
  expect(stores()).toBe(0);
  // A score like any other: a member changes it, and the fill that follows succeeds.
  const applied = nextSyncStatus(provider);
  metaOf(doc).set("title", "Opened");
  expect(await applied).toBe(true);
  await expect.poll(() => contentOf(partsOf(doc).get(partId)!).has(bars[1]!), { timeout: 3 * FILL_DEBOUNCE_MS }).toBe(true);
});

test.each([
  { reason: "missingMigration", version: 0, migrations: undefined, stored: () => docV0() },
  { reason: "migrationFailed", version: 0, migrations: [failing], stored: () => docV0() },
  {
    reason: "newerSchema",
    version: SCHEMA_VERSION + 1,
    migrations: undefined,
    stored: () => {
      const doc = docV0();
      metaOf(doc).set("schemaVersion", SCHEMA_VERSION + 1);
      return doc;
    },
  },
] as const)("a score the server cannot bring to its schema ($reason) is read-only for its Owner, who is told why, and is never written", async ({ reason, version, migrations, stored }) => {
  // With no migration registered, the published list has none from schema 0.
  const started = await startApp(migrations);
  const id = await createScore(started.app, started.session);
  const state = await storeAs(id, stored(), version);
  const row = (await Score.findByPk(id))!;
  const stores = countStores();

  const { provider, doc, notices } = await open(started, id);
  // As it was stored: nothing of a step that failed half-way either.
  expect(Y.encodeStateVector(doc)).toEqual(Y.encodeStateVector(await storedDoc(id)));
  expect(metaOf(doc).get("schemaVersion")).toBe(version);
  expect([...partsOf(doc).values()].map((part) => part.get("staves"))).toEqual([undefined, undefined]);
  await expect.poll(() => notices).toEqual([{ type: "readOnly", reason }]);
  const applied = nextSyncStatus(provider);
  metaOf(doc).set("title", "not kept");
  expect(await applied).toBe(false);
  // The server changes nothing of it either.
  await expect(started.app.collab.change(id, (server) => metaOf(server).set("title", "nor this"))).rejects.toThrow(/read-only/);

  // Closing the app stores every document still open: not this one.
  await started.app.close();
  expect(stores()).toBe(0);
  const after = (await Score.findByPk(id))!;
  expect(after.docState).toEqual(state);
  expect([after.title, after.schemaVersion, after.updatedAt]).toEqual([row.title, version, row.updatedAt]);
});

test("a part and a bar two members add at the same time get the content they miss from the server, the same for both, in one store", async () => {
  const started = await startApp();
  const id = await createScore(started.app, started.session);
  const [one, two] = [await open(started, id), await open(started, id)];
  const stores = countStores();

  // Neither has seen the other's change when it makes its own: the new part has no place for
  // the new bar, and neither member fills it in.
  const partId = addPart(one.doc, { name: "Bass", kind: "fretted", tuning: STANDARD_GUITAR.slice(0, 4) });
  const [barId] = insertBars(two.doc, { after: null, count: 1, timeSig: { numerator: 3, denominator: 4 } });
  expect(barsOf(one.doc).has(barId!)).toBe(false);
  await expect.poll(() => barsOf(one.doc).has(barId!) && partsOf(two.doc).has(partId)).toBe(true);
  expect(contentOf(partsOf(one.doc).get(partId)!).has(barId!)).toBe(false);

  const voicesIn = (doc: Y.Doc) => [...(contentOf(partsOf(doc).get(partId)!).get(barId!)?.keys() ?? [])].sort();
  await expect.poll(() => [voicesIn(one.doc), voicesIn(two.doc)], { timeout: 3 * FILL_DEBOUNCE_MS }).toEqual([
    ["0:0", "0:1"],
    ["0:0", "0:1"],
  ]);
  const read = docToJson(one.doc);
  expect(docToJson(two.doc)).toEqual(read);
  expect(read.parts.find((part) => part.id === partId)!.content[barId!]).toEqual({ "0:0": [] });

  // The members' changes and the server's fill are stored once, and storing changes nothing
  // that would be stored again.
  await expect.poll(stores, { timeout: 2 * STORE_DEBOUNCE_MS }).toBe(1);
  await wait(STORE_DEBOUNCE_MS + FILL_DEBOUNCE_MS + 500);
  expect(stores()).toBe(1);
  const kept = new Y.Doc();
  Y.applyUpdate(kept, (await Score.findByPk(id))!.docState);
  expect(docToJson(kept)).toEqual(read);
}, SLOW);

test("the title and the artist a member writes are mirrored to the scores table; a title that is not a string is stored without failing", async () => {
  const started = await startApp();
  const id = await createScore(started.app, started.session, "原本的標題");
  const created = (await Score.findByPk(id))!;
  expect([created.title, created.artist, created.schemaVersion]).toEqual(["原本的標題", null, SCHEMA_VERSION]);
  const { provider, doc } = await open(started, id);
  const failures = vi.spyOn(console, "error");
  const stores = countStores();
  const row = async () => {
    const score = (await Score.findByPk(id))!;
    return [score.title, score.artist];
  };

  let applied = nextSyncStatus(provider);
  doc.transact(() => {
    metaOf(doc).set("title", "新的標題");
    metaOf(doc).set("artist", "某個樂團");
  });
  expect(await applied).toBe(true);
  await expect.poll(row, { timeout: 2 * STORE_DEBOUNCE_MS }).toEqual(["新的標題", "某個樂團"]);
  const mirrored = (await Score.findByPk(id))!;
  expect(mirrored.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  // One change, one store: storing did not change the document again.
  await wait(STORE_DEBOUNCE_MS + FILL_DEBOUNCE_MS + 500);
  expect(stores()).toBe(1);

  // Whatever a member wrote there reads as no title and no artist, and the document is kept.
  applied = nextSyncStatus(provider);
  doc.transact(() => {
    metaOf(doc).set("title", 42);
    metaOf(doc).set("artist", { not: "a string" });
  });
  expect(await applied).toBe(true);
  await expect.poll(row, { timeout: 2 * STORE_DEBOUNCE_MS }).toEqual(["", null]);
  const kept = new Y.Doc();
  Y.applyUpdate(kept, (await Score.findByPk(id))!.docState);
  expect(metaOf(kept).get("title")).toBe(42);
  expect(stores()).toBe(2);
  expect(failures).not.toHaveBeenCalled();
}, SLOW);
