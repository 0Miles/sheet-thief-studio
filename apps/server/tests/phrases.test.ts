// The phrases API (docs/spec/routes.md, 3.7; docs/spec/phrases.md, sections 4 and 5.1): my
// library listed, filtered and searched; the revision every write counts; the 1 MB limit; and
// nobody but the owner reaching a phrase.
import { type BarsFragment, blankFragment, MAX_FRAGMENT_BYTES, jsonBytes, PART_PRESETS } from "@studio/score-model";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { createAccount } from "../src/accounts";
import { buildApp } from "../src/app";
import { COOKIE, freshDatabase, freshRedis, ORIGIN, sessionOf, testConfig } from "./support";

const PASSWORD = "a password long enough";

let sequelize: Sequelize;
let redis: Redis;
let app: FastifyInstance;
let anna: string;
let ben: string;

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  app = buildApp({ config: testConfig(), redis, logger: false });
  const account = (username: string, displayName: string) => createAccount({ username, displayName, password: PASSWORD, isAdmin: false, mustChangePassword: false });
  await account("anna", "安娜");
  await account("ben", "班");
});

beforeEach(async () => {
  await redis.flushdb();
  await sequelize.query("TRUNCATE phrases");
  anna = await sessionOf(app, "anna", PASSWORD);
  ben = await sessionOf(app, "ben", PASSWORD);
});

afterAll(async () => {
  await app.close();
  await redis.quit();
  await sequelize.close();
});

function call(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, session: string, payload?: unknown) {
  return app.inject({ method, url, headers: { origin: ORIGIN }, cookies: { [COOKIE]: session }, ...(payload === undefined ? {} : { payload: payload as object }) });
}

const guitar = blankFragment(PART_PRESETS.guitar6);
const bass = blankFragment(PART_PRESETS.bass5);
const drums = blankFragment(PART_PRESETS.drums);
const keys = blankFragment(PART_PRESETS.keys);

/** A riff of two bars: one beat in the first. */
const riff: BarsFragment = {
  kind: "fretted",
  tuning: [...PART_PRESETS.guitar6.tuning],
  bars: [
    { timeSig: { numerator: 4, denominator: 4 }, voices: { "0:0": [{ value: 4, dots: 0, notes: { s6: { fret: 3 } } }] } },
    { timeSig: { numerator: 4, denominator: 4 }, voices: { "0:0": [] } },
  ],
};

/** A new phrase of this session's account; returns its id. */
async function createPhrase(session: string, name: string, fragment: BarsFragment = guitar): Promise<string> {
  const response = await call("POST", "/api/phrases", session, { name, fragment });
  expect([response.statusCode, response.json()]).toEqual([201, { id: expect.any(String), revision: 1 }]);
  return (response.json() as { id: string }).id;
}

/** A fragment of `bytes` or more of JSON in UTF-8, made of beats whose text is three bytes a character. */
function fragmentOfAtLeast(bytes: number): BarsFragment {
  const beat = { value: 64 as const, dots: 0 as const, notes: {}, text: "譜".repeat(64) };
  const count = Math.ceil(bytes / jsonBytes(beat));
  return { kind: "fretted", tuning: [...PART_PRESETS.guitar6.tuning], bars: [{ timeSig: { numerator: 4, denominator: 4 }, voices: { "0:0": Array(count).fill(beat) } }] };
}

test("a new phrase is read back as it was written, its revision 1, and is listed with its counts", async () => {
  const id = await createPhrase(anna, "前奏", riff);
  const read = await call("GET", `/api/phrases/${id}`, anna);
  expect([read.statusCode, read.json()]).toEqual([200, { id, name: "前奏", fragment: riff, revision: 1, updatedAt: expect.any(String) }]);

  await createPhrase(anna, "鍵盤", keys);
  const list = await call("GET", "/api/phrases", anna);
  expect(list.json()).toEqual({
    phrases: expect.arrayContaining([
      { id, name: "前奏", kind: "fretted", stringCount: 6, staffCount: null, barCount: 2, updatedAt: expect.any(String), revision: 1 },
      { id: expect.any(String), name: "鍵盤", kind: "pitched", stringCount: null, staffCount: 2, barCount: 1, updatedAt: expect.any(String), revision: 1 },
    ]),
  });
});

test("saving writes the whole fragment over the phrase and counts one more revision; a save or rename made from another revision is refused with 409", async () => {
  const id = await createPhrase(anna, "前奏");
  const saved = await call("PUT", `/api/phrases/${id}`, anna, { fragment: riff, baseRevision: 1 });
  expect([saved.statusCode, saved.json()]).toEqual([200, { revision: 2 }]);

  // Another tab still at revision 1: refused, and what was saved stays.
  const stale = await call("PUT", `/api/phrases/${id}`, anna, { fragment: bass, baseRevision: 1 });
  expect([stale.statusCode, stale.json()]).toEqual([409, { code: "revision_conflict" }]);
  const ahead = await call("PUT", `/api/phrases/${id}`, anna, { fragment: bass, baseRevision: 3 });
  expect([ahead.statusCode, ahead.json()]).toEqual([409, { code: "revision_conflict" }]);
  expect((await call("GET", `/api/phrases/${id}`, anna)).json()).toMatchObject({ fragment: riff, revision: 2 });

  const renamed = await call("PATCH", `/api/phrases/${id}`, anna, { name: "主歌", baseRevision: 2 });
  expect([renamed.statusCode, renamed.json()]).toEqual([200, { revision: 3 }]);
  const staleName = await call("PATCH", `/api/phrases/${id}`, anna, { name: "副歌", baseRevision: 2 });
  expect([staleName.statusCode, staleName.json()]).toEqual([409, { code: "revision_conflict" }]);
  expect((await call("GET", `/api/phrases/${id}`, anna)).json()).toMatchObject({ name: "主歌", fragment: riff, revision: 3 });

  // The counts the list shows follow the content.
  await call("PUT", `/api/phrases/${id}`, anna, { fragment: bass, baseRevision: 3 });
  expect((await call("GET", "/api/phrases", anna)).json()).toEqual({
    phrases: [{ id, name: "主歌", kind: "fretted", stringCount: 5, staffCount: null, barCount: 1, updatedAt: expect.any(String), revision: 4 }],
  });
});

test("two saves made from the same revision at once: one is written, the other refused", async () => {
  const id = await createPhrase(anna, "前奏");
  const answers = await Promise.all([riff, bass].map((fragment) => call("PUT", `/api/phrases/${id}`, anna, { fragment, baseRevision: 1 })));
  expect(answers.map((answer) => answer.statusCode).sort()).toEqual([200, 409]);
  expect((await call("GET", `/api/phrases/${id}`, anna)).json()).toMatchObject({ revision: 2 });
});

test("a fragment of more than 1 MB of JSON is refused with 413, counted in bytes, and nothing is written", async () => {
  const id = await createPhrase(anna, "前奏");
  const big = fragmentOfAtLeast(MAX_FRAGMENT_BYTES + 1);
  // More than 1 MB in UTF-8, though far fewer characters.
  expect(JSON.stringify(big).length).toBeLessThan(MAX_FRAGMENT_BYTES);
  expect(jsonBytes(big)).toBeGreaterThan(MAX_FRAGMENT_BYTES);

  for (const response of [await call("PUT", `/api/phrases/${id}`, anna, { fragment: big, baseRevision: 1 }), await call("POST", "/api/phrases", anna, { name: "太大", fragment: big })]) {
    expect([response.statusCode, response.json()]).toEqual([413, { code: "phrase_too_large" }]);
  }
  expect((await call("GET", `/api/phrases/${id}`, anna)).json()).toMatchObject({ fragment: guitar, revision: 1 });
  expect((await call("GET", "/api/phrases", anna)).json().phrases).toHaveLength(1);

  // Just within the limit is written.
  const fits = fragmentOfAtLeast(MAX_FRAGMENT_BYTES - 64 * 1024);
  expect(jsonBytes(fits)).toBeLessThanOrEqual(MAX_FRAGMENT_BYTES);
  expect((await call("PUT", `/api/phrases/${id}`, anna, { fragment: fits, baseRevision: 1 })).json()).toEqual({ revision: 2 });

  // A body far past the fragment's limit is refused before it is read.
  const huge = await call("PUT", `/api/phrases/${id}`, anna, { fragment: fragmentOfAtLeast(2 * MAX_FRAGMENT_BYTES), baseRevision: 2 });
  expect([huge.statusCode, huge.json()]).toEqual([413, { code: "payload_too_large" }]);
});

test("a fragment that is not legal is refused with 400, as is a name too long or empty", async () => {
  const id = await createPhrase(anna, "前奏");
  const withIds = { ...riff, bars: [{ ...riff.bars[0], voices: { "0:0": [{ id: "x1", value: 4, dots: 0, notes: {} }] } }] };
  const withTempo = { ...riff, bars: [{ ...riff.bars[0], tempo: 120 }] };
  const answers = [
    await call("POST", "/api/phrases", anna, { name: "有 id", fragment: withIds }),
    await call("POST", "/api/phrases", anna, { name: "有速度", fragment: withTempo }),
    await call("POST", "/api/phrases", anna, { name: "", fragment: guitar }),
    await call("POST", "/api/phrases", anna, { name: "長".repeat(101), fragment: guitar }),
    await call("PUT", `/api/phrases/${id}`, anna, { fragment: withIds, baseRevision: 1 }),
    await call("PUT", `/api/phrases/${id}`, anna, { fragment: riff }),
    await call("PATCH", `/api/phrases/${id}`, anna, { name: "  ", baseRevision: 1 }),
  ];
  for (const answer of answers) expect([answer.statusCode, answer.json().code]).toEqual([400, "invalid_request"]);
  expect((await call("GET", `/api/phrases/${id}`, anna)).json()).toMatchObject({ name: "前奏", fragment: guitar, revision: 1 });
});

test("someone else's phrase does not exist for me: every call on it answers 404, and it is not in my list", async () => {
  const id = await createPhrase(anna, "前奏");
  const answers = [
    await call("GET", `/api/phrases/${id}`, ben),
    await call("PUT", `/api/phrases/${id}`, ben, { fragment: riff, baseRevision: 1 }),
    await call("PATCH", `/api/phrases/${id}`, ben, { name: "我的", baseRevision: 1 }),
    await call("POST", `/api/phrases/${id}/duplicate`, ben),
    await call("DELETE", `/api/phrases/${id}`, ben),
    // No such phrase, and an id that is none.
    await call("GET", "/api/phrases/00000000-0000-4000-8000-000000000000", anna),
    await call("PUT", "/api/phrases/not-a-phrase", anna, { fragment: riff, baseRevision: 1 }),
    await call("DELETE", "/api/phrases/not-a-phrase", anna),
  ];
  for (const answer of answers) expect([answer.statusCode, answer.json()]).toEqual([404, { code: "not_found" }]);
  expect((await call("GET", "/api/phrases", ben)).json()).toEqual({ phrases: [] });
  expect((await call("GET", `/api/phrases/${id}`, anna)).json()).toMatchObject({ name: "前奏", fragment: guitar, revision: 1 });

  // Without a session, nothing at all.
  const anonymous = await app.inject({ method: "GET", url: "/api/phrases" });
  expect([anonymous.statusCode, anonymous.json()]).toEqual([401, { code: "unauthenticated" }]);
});

test("the list is most recently updated first, filtered by kind, searched by a part of the name in either case", async () => {
  const intro = await createPhrase(anna, "Intro 前奏", riff);
  const groove = await createPhrase(anna, "Groove", drums);
  const chords = await createPhrase(anna, "intro chords", keys);
  const percent = await createPhrase(anna, "100% 前奏", bass);
  await createPhrase(ben, "Intro of Ben", riff);
  // Every phrase so far a minute older, so that the next write is the most recent by far.
  const age = () => sequelize.query("UPDATE phrases SET updated_at = updated_at - interval '1 minute'");
  await age();
  // The oldest were changed last: saving or renaming makes a phrase the most recent.
  await call("PATCH", `/api/phrases/${groove}`, anna, { name: "Groove A", baseRevision: 1 });
  await age();
  await call("PUT", `/api/phrases/${intro}`, anna, { fragment: riff, baseRevision: 1 });

  const ids = async (query: string) => ((await call("GET", `/api/phrases${query}`, anna)).json() as { phrases: { id: string }[] }).phrases.map((phrase) => phrase.id);
  const all = await ids("");
  expect(all.slice(0, 2)).toEqual([intro, groove]);
  expect(new Set(all.slice(2))).toEqual(new Set([chords, percent]));

  expect(await ids("?kind=percussion")).toEqual([groove]);
  expect(new Set(await ids("?kind=fretted"))).toEqual(new Set([intro, percent]));
  expect(await ids("?kind=fretted&q=intro")).toEqual([intro]);
  expect(new Set(await ids(`?q=${encodeURIComponent("INTRO")}`))).toEqual(new Set([intro, chords]));
  expect(new Set(await ids(`?q=${encodeURIComponent("前奏")}`))).toEqual(new Set([intro, percent]));
  // A wildcard of SQL is only itself.
  expect(await ids(`?q=${encodeURIComponent("%")}`)).toEqual([percent]);
  expect(await ids(`?q=${encodeURIComponent("_")}`)).toEqual([]);
  expect(await ids("?q=nothing")).toEqual([]);
  expect((await ids("?q=")).length).toBe(4);

  const unknownKind = await call("GET", "/api/phrases?kind=piano", anna);
  expect([unknownKind.statusCode, unknownKind.json().code]).toEqual([400, "invalid_request"]);
});

test("a copy has the same content under the name with 「（副本）」, at revision 1; deleting removes only the phrase deleted", async () => {
  const id = await createPhrase(anna, "前奏", riff);
  await call("PUT", `/api/phrases/${id}`, anna, { fragment: riff, baseRevision: 1 });
  const copied = await call("POST", `/api/phrases/${id}/duplicate`, anna);
  expect([copied.statusCode, copied.json()]).toEqual([201, { id: expect.any(String) }]);
  const copy = (copied.json() as { id: string }).id;
  expect((await call("GET", `/api/phrases/${copy}`, anna)).json()).toEqual({ id: copy, name: "前奏（副本）", fragment: riff, revision: 1, updatedAt: expect.any(String) });

  // A name that would pass 100 characters with the suffix is cut short to fit.
  const long = await createPhrase(anna, "長".repeat(100));
  const longCopy = ((await call("POST", `/api/phrases/${long}/duplicate`, anna)).json() as { id: string }).id;
  expect((await call("GET", `/api/phrases/${longCopy}`, anna)).json().name).toBe(`${"長".repeat(96)}（副本）`);

  const deleted = await call("DELETE", `/api/phrases/${id}`, anna);
  expect(deleted.statusCode).toBe(204);
  expect((await call("GET", `/api/phrases/${id}`, anna)).statusCode).toBe(404);
  expect((await call("GET", `/api/phrases/${copy}`, anna)).statusCode).toBe(200);
});
