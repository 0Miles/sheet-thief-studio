// Importing a file as a new score (docs/spec/import-export.md, section 2; docs/spec/routes.md,
// 3.3): the web app reads the file and sends the `ScoreJSON` it made; the server checks it with zod
// and writes it into a new document as a participant, its sender the Owner.
import { docToJson, jsonBytes, jsonToDoc, MAX_BARS, MAX_IMPORT_BYTES, MAX_VALUE_DEPTH, SCHEMA_VERSION, type ScoreJSON } from "@studio/score-model";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import { Score, ScoreMember } from "../src/db/models";
import { IMPORT_BODY_LIMIT } from "../src/limits";
import { COOKIE, freshDatabase, freshRedis, listen, type OpenScore, openScore, ORIGIN, sessionOf, testConfig, ticketFor } from "./support";

const PASSWORD = "a password long enough";

let sequelize: Sequelize;
let redis: Redis;
let app: FastifyInstance;
let collabUrl: string;
let annaId: string;
let anna: string;
let opened: OpenScore[] = [];

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  app = buildApp({ config: testConfig(), redis, logger: false });
  collabUrl = await listen(app);
  annaId = (await createAccount({ username: "anna", displayName: "安娜", password: PASSWORD, isAdmin: false, mustChangePassword: false })).id;
});

beforeEach(async () => {
  await redis.flushdb();
  await sequelize.query("TRUNCATE scores CASCADE");
  anna = await sessionOf(app, "anna", PASSWORD);
});

afterEach(() => {
  for (const { provider } of opened) provider.destroy();
  opened = [];
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  await redis.quit();
  await sequelize.close();
});

function send(payload: unknown, session: string | null = anna, origin = ORIGIN) {
  return app.inject({
    method: "POST",
    url: "/api/scores/import",
    headers: { origin, "content-type": "application/json" },
    ...(session === null ? {} : { cookies: { [COOKIE]: session } }),
    // As a string: a body the test builds by hand (a __proto__ key) goes as written.
    payload: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

type PartJSON = ScoreJSON["parts"][number];

const COMMON = { numerator: 4, denominator: 4 } as const;

/**
 * A score as an import makes one: the three kinds of part, techniques, lyrics, a repeat with
 * voltas, a section, changes of tempo, key and time. As `docToJson` reads it back, so that what
 * the server writes can be compared with it field for field.
 */
const BAND: ScoreJSON = docToJson(
  jsonToDoc({
    schemaVersion: SCHEMA_VERSION,
    title: "匯入的歌",
    artist: "樂團",
    bars: [
      { id: "b1", timeSig: COMMON, tempo: 96, keySig: { fifths: 2, mode: "major" }, section: "Intro", repeatStart: true },
      { id: "b2", timeSig: COMMON, voltas: [1], repeatEnd: 2 },
      { id: "b3", timeSig: { numerator: 3, denominator: 4 }, voltas: [2], tempo: 140 },
    ],
    parts: [
      {
        id: "guitar",
        name: "Guitar",
        kind: "fretted",
        tuning: [64, 59, 55, 50, 45, 40],
        capo: 2,
        program: 27,
        staves: [{ clef: "tab" }],
        content: {
          b1: { "0:0": [{ id: "g1", value: 4, dots: 1, stroke: "down", notes: { s1: { fret: 3, bend: { type: "bend", semitones: 2 } }, s2: { fret: 5, palmMute: true } } }] },
          b3: { "0:0": [{ id: "g2", value: 2, dots: 0, dynamic: "mf", notes: { s6: { dead: true } } }] },
        },
      },
      {
        id: "drums",
        name: "Drums",
        kind: "percussion",
        tuning: [],
        capo: 0,
        program: 0,
        staves: [{ clef: "neutral" }],
        content: { b2: { "0:0": [{ id: "d1", value: 8, dots: 0, notes: { p36: {}, p42: { ghost: true } } }] } },
      },
      {
        id: "keys",
        name: "Keys",
        kind: "pitched",
        tuning: [],
        capo: 0,
        program: 0,
        staves: [{ clef: "treble" }, { clef: "bass" }],
        content: {
          b1: {
            "0:0": [{ id: "k1", value: 4, dots: 0, lyric: "啦", text: "rit.", notes: { n66: { spell: "F#" } } }],
            "1:0": [{ id: "k2", value: 1, dots: 0, notes: { n38: {} } }],
          },
        },
      },
    ],
  }),
);

const [GUITAR, DRUMS, KEYS] = BAND.parts as [PartJSON, PartJSON, PartJSON];

/** A score of one bar whose part holds `count` beats with text: some 220 bytes of JSON each. */
function wordyScore(count: number): ScoreJSON {
  const beats = Array.from({ length: count }, (_, index) => ({ id: `w${String(index).padStart(6, "0")}`, value: 64 as const, dots: 0 as const, notes: {}, text: "譜".repeat(64) }));
  return { ...BAND, bars: [{ id: "b1", timeSig: COMMON }], parts: [{ ...KEYS, content: { b1: { "0:0": beats } } }] };
}

/** A score of `bytes` of JSON or a little more: as many beats as it takes. */
function scoreOfAtLeast(bytes: number): ScoreJSON {
  const one = jsonBytes(wordyScore(1));
  const each = jsonBytes(wordyScore(2)) - one;
  return wordyScore(1 + Math.ceil((bytes - one) / each));
}

test("a score imported by anyone logged in is made with their account as its Owner, its title and artist on its row, and listed as theirs", async () => {
  const response = await send({ score: BAND });
  expect(response.statusCode).toBe(201);
  const { id } = response.json() as { id: string };

  const members = await ScoreMember.findAll({ where: { scoreId: id } });
  expect(members.map(({ accountId, role }) => ({ accountId, role }))).toEqual([{ accountId: annaId, role: "owner" }]);
  const list = await app.inject({ method: "GET", url: "/api/scores", cookies: { [COOKIE]: anna } });
  expect(list.json()).toEqual({ scores: [{ id, title: "匯入的歌", artist: "樂團", role: "owner", updatedAt: expect.any(String) }] });
});

test("an imported score read through a real provider is the ScoreJSON sent, ids and all", async () => {
  const { id } = (await send({ score: BAND })).json() as { id: string };
  const member = await openScore(collabUrl, id, () => ticketFor(app, id, anna));
  opened.push(member);
  expect(docToJson(member.doc)).toEqual(BAND);
});

test("a score past the limits on bars or parts, or past 5 MB of JSON, is refused with 400 and nothing is made", async () => {
  const made = vi.spyOn(Score, "create");
  const tooLarge = scoreOfAtLeast(MAX_IMPORT_BYTES + 1);
  // Past 5 MB, yet within the body's limit: the score's own limit refuses it, not Fastify's.
  expect(jsonBytes(tooLarge)).toBeGreaterThan(MAX_IMPORT_BYTES);
  expect(jsonBytes({ score: tooLarge })).toBeLessThanOrEqual(IMPORT_BODY_LIMIT);

  for (const score of [
    { ...BAND, bars: Array.from({ length: MAX_BARS + 1 }, (_, index) => ({ id: `b${index}`, timeSig: COMMON })), parts: [] },
    // Seventeen parts.
    { ...BAND, parts: [...Array.from({ length: 15 }, (_, index) => ({ ...GUITAR, id: `g${index}` })), { ...DRUMS, id: "d1" }, { ...DRUMS, id: "d2" }] },
    // Sixteen parts other than drums.
    { ...BAND, parts: Array.from({ length: 16 }, (_, index) => ({ ...GUITAR, id: `g${index}` })) },
    tooLarge,
  ]) {
    const response = await send({ score });
    expect([response.statusCode, response.json().code]).toEqual([400, "invalid_request"]);
  }
  expect(made).not.toHaveBeenCalled();
  expect(await Score.count()).toBe(0);
});

test("a score at the limits is made: a thousand bars, sixteen parts of which one is drums, and 5 MB of JSON", async () => {
  const bars = Array.from({ length: MAX_BARS }, (_, index) => ({ id: `b${index}`, timeSig: COMMON }));
  const parts = [...Array.from({ length: 15 }, (_, index) => ({ ...GUITAR, id: `g${index}`, content: {} })), { ...DRUMS, content: {} }];
  expect((await send({ score: { ...BAND, bars, parts } })).statusCode).toBe(201);

  // Just within 5 MB: one beat fewer than a score past it.
  const past = scoreOfAtLeast(MAX_IMPORT_BYTES + 1);
  const voice = past.parts[0]!.content.b1!["0:0"]!;
  const fits = { ...past, parts: [{ ...past.parts[0]!, content: { b1: { "0:0": voice.slice(0, -1) } } }] };
  expect(jsonBytes(fits)).toBeLessThanOrEqual(MAX_IMPORT_BYTES);
  expect((await send({ score: fits })).statusCode).toBe(201);
});

test("a body past 5 MB and 64 KB is refused with 413 before it is read, and nothing is made", async () => {
  const made = vi.spyOn(Score, "create");
  const response = await send({ score: scoreOfAtLeast(IMPORT_BODY_LIMIT + 1) });
  expect([response.statusCode, response.json()]).toEqual([413, { code: "payload_too_large" }]);
  expect(made).not.toHaveBeenCalled();
  expect(await Score.count()).toBe(0);
});

test("a score zod refuses is refused with 400 and nothing is made: not legal, untitled, of another schema version, with a __proto__ key, nested too deep", async () => {
  const made = vi.spyOn(Score, "create");
  let deep: unknown = 1;
  for (let level = 0; level < MAX_VALUE_DEPTH + 1; level++) deep = [deep];
  for (const payload of [
    {},
    { score: null },
    // A title of 1 to 100 characters, not white space only, as a new score has.
    { score: { ...BAND, title: "" } },
    { score: { ...BAND, title: "   " } },
    { score: { ...BAND, title: "x".repeat(101) } },
    { score: { ...BAND, schemaVersion: SCHEMA_VERSION + 1 } },
    { score: { ...BAND, schemaVersion: SCHEMA_VERSION - 1 } },
    { score: { ...BAND, parts: [{ ...GUITAR, kind: "banjo" }] } },
    // Content for a bar the score has not.
    { score: { ...BAND, parts: [{ ...GUITAR, content: { b9: { "0:0": [] } } }] } },
    // A note on a string the guitar has not.
    { score: { ...BAND, parts: [{ ...GUITAR, content: { b1: { "0:0": [{ id: "x", value: 4, dots: 0, notes: { s7: { fret: 1 } } }] } } }] } },
    // Two bars with the same id.
    { score: { ...BAND, bars: [...BAND.bars, BAND.bars[0]] } },
    // Nested past the depth of the document's values, in a field zod would not even read.
    { score: { ...BAND, parts: [{ ...GUITAR, extra: deep }] } },
  ]) {
    const response = await send(payload);
    expect([response.statusCode, response.json().code]).toEqual([400, "invalid_request"]);
  }
  // A key named __proto__ in the content, as the bytes on the wire hold it.
  const poisoned = JSON.stringify({ score: BAND }).replace('"content":{"b1"', '"content":{"__proto__":{"0:0":[]},"b1"');
  expect(poisoned).toContain("__proto__");
  const response = await send(poisoned);
  expect([response.statusCode, response.json().code]).toEqual([400, "invalid_request"]);

  expect(made).not.toHaveBeenCalled();
  expect(await Score.count()).toBe(0);
});

test("an import needs a session and a request from our origin", async () => {
  expect((await send({ score: BAND }, null)).statusCode).toBe(401);
  expect((await send({ score: BAND }, anna, "https://elsewhere.example")).statusCode).toBe(403);
  expect(await Score.count()).toBe(0);
});
