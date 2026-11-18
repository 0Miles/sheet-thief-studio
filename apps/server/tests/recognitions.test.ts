// Recognizing images (docs/spec/recognizer.md, section 7; docs/spec/routes.md, 3.8): the images
// checked as they come, one recognition at a time per account and on the server, the recognizer
// called in the background, what it answers recorded, and nobody but the account that started a
// recognition reaching it. The recognizer is a stand-in answering the contract fixtures
// (fakeRecognizer.ts); Postgres and Redis are real.
import { type RecognitionDetails, type RecognizerResult, recognizerFailure } from "@studio/contracts";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import type { Sequelize } from "sequelize";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { buildApp } from "../src/app";
import { Recognition, RecognitionImage } from "../src/db/models";
import { PURGE_INTERVAL_MS } from "../src/deletion";
import { MB } from "../src/limits";
import { fragmentOfRecognition } from "../src/recognitionFragment";
import { recognize } from "../src/recognizer";
import { answers, type FakeAnswer, type FakeRecognizer, fixture, fixtureNames, startFakeRecognizer } from "./fakeRecognizer";
import { apiCall, COOKIE, createMembers, freshDatabase, freshRedis, NO_RECOGNIZER, ORIGIN, sessionOf, testConfig, warmPool } from "./support";

const PASSWORD = "a password long enough";

let sequelize: Sequelize;
let redis: Redis;
let recognizer: FakeRecognizer;
let app: FastifyInstance;
let anna: string;
let ben: string;
/** The accounts' ids, by username. */
let accounts: Record<string, string>;

/** An app of its own, closed after the test. */
const ownApps: FastifyInstance[] = [];
function startApp(recognizerUrl = recognizer.url): FastifyInstance {
  const started = buildApp({ config: testConfig({ RECOGNIZER_URL: recognizerUrl }), redis, logger: false });
  ownApps.push(started);
  return started;
}

beforeAll(async () => {
  sequelize = await freshDatabase();
  redis = await freshRedis();
  recognizer = await startFakeRecognizer();
  app = buildApp({ config: testConfig({ RECOGNIZER_URL: recognizer.url }), redis, logger: false });
  accounts = await createMembers(["anna", "ben"], PASSWORD);
});

beforeEach(async () => {
  await sequelize.query("TRUNCATE recognitions CASCADE");
  recognizer.answer(answers.recognized());
  recognizer.received.length = 0;
  anna = await sessionOf(app, "anna", PASSWORD);
  ben = await sessionOf(app, "ben", PASSWORD);
});

afterEach(async () => {
  for (const release of holding.splice(0)) release(answers.recognized());
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(ownApps.splice(0).map((each) => each.close()));
});

afterAll(async () => {
  await app.close();
  await recognizer.close();
  await redis.quit();
  await sequelize.close();
});

/** Bytes a file of each type starts with, and some more. */
const png = (fill = 1, size = 64) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size, fill)]);
const jpeg = (fill = 2) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, fill)]);
const webp = (fill = 3) => Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x40, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(64, fill)]);
/** A HEIC photo, as some phone cameras take them: an ISO media file of brand heic. */
const heic = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypheic"), Buffer.alloc(64, 4)]);

interface Upload {
  data: Buffer;
  /** What the browser says the file is; the server goes by its bytes. */
  type?: string;
  field?: string;
}

/** Send files as the review page does: `multipart/form-data`, each in a field `images`. */
async function upload(session: string, files: Upload[], on: FastifyInstance = app) {
  const form = new FormData();
  files.forEach(({ data, type = "image/png", field = "images" }, index) => form.append(field, new Blob([new Uint8Array(data)], { type }), `page-${index + 1}`));
  const encoded = new Response(form);
  const payload = Buffer.from(await encoded.arrayBuffer());
  return on.inject({ method: "POST", url: "/api/recognitions", headers: { origin: ORIGIN, "content-type": encoded.headers.get("content-type")! }, cookies: { [COOKIE]: session }, payload });
}

/** Start a recognition of these images; its id. */
async function started(session: string, files: Upload[] = [{ data: png() }], on: FastifyInstance = app): Promise<string> {
  const response = await upload(session, files, on);
  expect(response.statusCode, response.body).toBe(202);
  return (response.json() as { id: string }).id;
}

function details(id: string, session: string, on: FastifyInstance = app) {
  return apiCall(on, "GET", `/api/recognitions/${id}`, session);
}

/** The recognition once it is no longer running, polled as the browser does. */
async function finished(id: string, session: string, on: FastifyInstance = app): Promise<RecognitionDetails> {
  for (let attempt = 0; attempt < 500; attempt++) {
    const response = await details(id, session, on);
    expect(response.statusCode).toBe(200);
    const read = response.json() as RecognitionDetails;
    if (read.status !== "running") return read;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`recognition ${id} is still running`);
}

/** The answers held back, let go after each test whatever became of it, so that a failing test leaves the recognizer free. */
const holding: Array<(answer: FakeAnswer) => void> = [];

/** An answer the stand-in holds back until the test lets it go. */
function heldBack() {
  let release!: (answer: FakeAnswer) => void;
  const answer = new Promise<FakeAnswer>((resolve) => (release = resolve));
  holding.push(release);
  return { answering: () => answer, release };
}

/** Until the stand-in has received so many requests. */
async function receivedCount(count: number): Promise<void> {
  await vi.waitUntil(() => recognizer.received.length >= count, { timeout: 5000 });
}

test("images of the three types are sent to the recognizer in order, and its result is kept as a fragment with its report, the images readable", async () => {
  const pages = [png(), jpeg(), webp()];
  // What the browser says of the files does not count: their bytes do.
  const id = await started(anna, [{ data: pages[0]!, type: "application/octet-stream" }, { data: pages[1]! }, { data: pages[2]!, type: "" }]);
  expect(await finished(id, anna)).toEqual({
    id,
    status: "succeeded",
    pages: 3,
    createdAt: expect.any(String),
    ...fragmentOfRecognition(fixture("six-strings") as RecognizerResult),
  });
  expect(recognizer.received).toHaveLength(1);
  expect(recognizer.received[0]!.map(({ type, data }) => ({ type, data }))).toEqual([
    { type: "image/png", data: pages[0] },
    { type: "image/jpeg", data: pages[1] },
    { type: "image/webp", data: pages[2] },
  ]);
  for (const [index, type] of ["image/png", "image/jpeg", "image/webp"].entries()) {
    const image = await apiCall(app, "GET", `/api/recognitions/${id}/images/${index + 1}`, anna);
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toBe(type);
    expect(image.headers["cache-control"]).toBe("private, no-store");
    expect(image.rawPayload).toEqual(pages[index]);
  }
  for (const page of ["0", "4", "01", "x"]) expect((await apiCall(app, "GET", `/api/recognitions/${id}/images/${page}`, anna)).statusCode).toBe(404);
  const list = await apiCall(app, "GET", "/api/recognitions", anna);
  expect(list.json()).toEqual({ recognitions: [{ id, status: "succeeded", pages: 3, createdAt: expect.any(String) }] });
});

test("anything but PNG, JPEG and WebP is refused with 415 unsupported_image, a HEIC photo too, and nothing is kept or sent", async () => {
  for (const [files, page] of [
    [[{ data: Buffer.from("not an image at all") }], 1],
    [[{ data: png() }, { data: heic(), type: "image/heic" }], 2],
    [[{ data: Buffer.from("GIF89a and some more bytes"), type: "image/gif" }], 1],
    [[{ data: png() }, { data: jpeg() }, { data: Buffer.alloc(0) }], 3],
  ] as const) {
    const response = await upload(anna, [...files]);
    expect(response.statusCode).toBe(415);
    expect(response.json()).toEqual({ code: "unsupported_image", params: { page } });
  }
  // A field `images` that is text, not a file.
  const form = new FormData();
  form.append("images", "a text");
  const encoded = new Response(form);
  const text = await app.inject({ method: "POST", url: "/api/recognitions", headers: { origin: ORIGIN, "content-type": encoded.headers.get("content-type")! }, cookies: { [COOKIE]: anna }, payload: Buffer.from(await encoded.arrayBuffer()) });
  expect(text.json()).toEqual({ code: "unsupported_image", params: { page: 1 } });
  expect(await Recognition.count()).toBe(0);
  expect(recognizer.received).toHaveLength(0);
});

test("1 to 15 images, at most 10 MB each and 40 MB in all", async () => {
  expect((await upload(anna, [])).json()).toEqual({ code: "invalid_request", params: { issues: [{ path: ["images"], code: "too_small" }] } });
  expect((await upload(anna, [{ data: png(), field: "image" }])).statusCode).toBe(400);
  const sixteen = await upload(anna, Array.from({ length: 16 }, (_, index) => ({ data: png(index) })));
  expect(sixteen.json()).toEqual({ code: "invalid_request", params: { issues: [{ path: ["images"], code: "too_big" }] } });
  const tooLarge = await upload(anna, [{ data: png(1, 10 * MB) }]);
  expect([tooLarge.statusCode, tooLarge.json()]).toEqual([413, { code: "payload_too_large" }]);
  const tooMuch = await upload(anna, Array.from({ length: 5 }, (_, index) => ({ data: png(index, 9 * MB) })));
  expect([tooMuch.statusCode, tooMuch.json()]).toEqual([413, { code: "payload_too_large" }]);
  // A JSON body is not images.
  expect((await apiCall(app, "POST", "/api/recognitions", anna, { images: [] })).statusCode).toBe(400);
  expect(await Recognition.count()).toBe(0);

  const fifteen = await started(anna, Array.from({ length: 15 }, (_, index) => ({ data: png(index, 2 * MB) })));
  expect((await finished(fifteen, anna)).pages).toBe(15);
  expect(recognizer.received[0]).toHaveLength(15);
});

test("while an account's recognition runs, its second one is refused with 409 and another account's with 503 recognizer_busy, neither recorded", async () => {
  const held = heldBack();
  recognizer.answer(held.answering);
  const id = await started(anna);
  await receivedCount(1);
  expect((await details(id, anna)).json()).toMatchObject({ status: "running" });

  const second = await upload(anna, [{ data: png() }]);
  expect([second.statusCode, second.json()]).toEqual([409, { code: "recognition_in_progress" }]);
  const others = await upload(ben, [{ data: png() }]);
  expect([others.statusCode, others.json()]).toEqual([503, { code: "recognizer_busy" }]);
  expect(await Recognition.count()).toBe(1);

  held.release(answers.recognized("four-strings"));
  expect(await finished(id, anna)).toMatchObject({ status: "succeeded", report: { strings: 4 } });
  // Free again, for either, as soon as it is seen finished.
  const bens = await started(ben);
  expect((await finished(bens, ben)).status).toBe("succeeded");
  expect((await finished(await started(anna), anna)).status).toBe("succeeded");
  expect(recognizer.received).toHaveLength(3);
});

test("two requests of the same account at once: one starts, the other is refused with 409, and only one is recorded", async () => {
  await warmPool(sequelize);
  const held = heldBack();
  recognizer.answer(held.answering);
  const both = await Promise.all([upload(anna, [{ data: png() }]), upload(anna, [{ data: jpeg() }])]);
  expect(both.map((response) => response.statusCode).sort()).toEqual([202, 409]);
  expect(both.find((response) => response.statusCode === 409)!.json()).toEqual({ code: "recognition_in_progress" });
  expect(await Recognition.count()).toBe(1);
  held.release(answers.recognized());
  const { id } = both.find((response) => response.statusCode === 202)!.json() as { id: string };
  expect((await finished(id, anna)).status).toBe("succeeded");
});

test("a request that would be refused is refused before its body is read: over the limit, it still answers 409 or 503", async () => {
  const held = heldBack();
  recognizer.answer(held.answering);
  const id = await started(anna);
  await receivedCount(1);
  const tooMuch = Array.from({ length: 5 }, (_, index) => ({ data: png(index, 9 * MB) }));
  expect((await upload(anna, tooMuch)).json()).toEqual({ code: "recognition_in_progress" });
  expect((await upload(ben, tooMuch)).json()).toEqual({ code: "recognizer_busy" });
  held.release(answers.recognized());
  expect((await finished(id, anna)).status).toBe("succeeded");
});

test("someone else's recognition, its images and an id of none answer 404, to read and to discard", async () => {
  const id = await started(anna);
  await finished(id, anna);
  for (const url of [`/api/recognitions/${id}`, `/api/recognitions/${id}/images/1`]) {
    expect((await apiCall(app, "GET", url, ben)).json()).toEqual({ code: "not_found" });
  }
  expect((await apiCall(app, "DELETE", `/api/recognitions/${id}`, ben)).statusCode).toBe(404);
  expect((await apiCall(app, "GET", "/api/recognitions", ben)).json()).toEqual({ recognitions: [] });
  for (const other of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
    expect((await details(other, anna)).statusCode).toBe(404);
    expect((await apiCall(app, "GET", `/api/recognitions/${other}/images/1`, anna)).statusCode).toBe(404);
    expect((await apiCall(app, "DELETE", `/api/recognitions/${other}`, anna)).statusCode).toBe(404);
  }
  // Nor without a session.
  expect((await apiCall(app, "GET", `/api/recognitions/${id}/images/1`, null)).statusCode).toBe(401);
  expect((await upload("no session", [{ data: png() }])).statusCode).toBe(401);
  expect((await details(id, anna)).statusCode).toBe(200);
});

test("discarding deletes the recognition and its images; one discarded while running is not brought back by its answer", async () => {
  const id = await started(anna, [{ data: png() }, { data: jpeg() }]);
  await finished(id, anna);
  expect((await apiCall(app, "DELETE", `/api/recognitions/${id}`, anna)).statusCode).toBe(204);
  expect((await details(id, anna)).statusCode).toBe(404);
  expect((await apiCall(app, "GET", `/api/recognitions/${id}/images/1`, anna)).statusCode).toBe(404);
  expect(await RecognitionImage.count()).toBe(0);

  const held = heldBack();
  recognizer.answer(held.answering);
  const running = await started(anna);
  await receivedCount(2);
  expect((await apiCall(app, "DELETE", `/api/recognitions/${running}`, anna)).statusCode).toBe(204);
  held.release(answers.recognized());
  // The next one waits for the recognizer to be free, then runs.
  recognizer.answer(answers.recognized());
  await vi.waitUntil(async () => (await upload(anna, [{ data: png() }])).statusCode === 202, { timeout: 5000 });
  expect(await Recognition.count({ where: { id: running } })).toBe(0);
});

test.each(fixtureNames().filter((name) => name.startsWith("error-")))("the recognizer failing with %s is recorded as failed with its code and pages", async (name) => {
  const { error } = recognizerFailure.parse(fixture(name));
  recognizer.answer(error.code === "busy" ? answers.busy() : answers.failed(name));
  const id = await started(anna);
  expect(await finished(id, anna)).toEqual({ id, status: "failed", pages: 1, createdAt: expect.any(String), error });
});

test("the recognizer still busy (503) is a failure with the code busy, whatever its body", async () => {
  recognizer.answer({ status: 503, body: "busy" });
  const id = await started(anna);
  expect(await finished(id, anna)).toMatchObject({ status: "failed", error: { code: "busy", params: {}, pages: [] } });
});

test("an answer not of the contract, an unexpected status, or no recognizer at all is a failure with the code unavailable", async () => {
  for (const answer of [
    { status: 200, body: { ...(fixture("six-strings") as object), version: 2 } },
    { status: 422, body: { error: "something" } },
    { status: 500, body: {} },
    { status: 400, body: {} },
  ]) {
    recognizer.answer(answer);
    const id = await started(anna);
    expect(await finished(id, anna)).toMatchObject({ status: "failed", error: { code: "unavailable", params: {}, pages: [] } });
  }
  const nowhere = startApp(NO_RECOGNIZER);
  const session = await sessionOf(nowhere, "ben", PASSWORD);
  const id = await started(session, undefined, nowhere);
  expect(await finished(id, session, nowhere)).toMatchObject({ status: "failed", error: { code: "unavailable" } });
});

test("an answer with a key __proto__ is not of the contract: unavailable", async () => {
  const six = JSON.stringify(fixture("six-strings"));
  for (const raw of [six.replace('"strings":', '"__proto__": {"polluted": true}, "strings":'), six.replace('"units":', '"__proto__": null, "units":')]) {
    recognizer.answer({ status: 200, raw });
    const id = await started(anna);
    expect(await finished(id, anna)).toMatchObject({ status: "failed", error: { code: "unavailable" } });
  }
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

test("no answer within the time the server waits is a failure with the code timeout; the server closing, interrupted", async () => {
  const held = heldBack();
  recognizer.answer(held.answering);
  const images = [{ mime: "image/png" as const, data: png() }];
  const log = app.log;
  expect(await recognize(recognizer.url, images, new AbortController().signal, log, 50)).toEqual({ status: "failed", error: { code: "timeout", params: {}, pages: [] } });
  const stop = new AbortController();
  const stopped = recognize(recognizer.url, images, stop.signal, log, 60_000);
  await receivedCount(2);
  stop.abort();
  expect(await stopped).toEqual({ status: "failed", error: { code: "interrupted", params: {}, pages: [] } });
  held.release(answers.recognized());
});

test("a result that makes no fragment of bars is a failure with the code recognition_failed", async () => {
  // More than 1 MB of fragment: 3000 bars of six notes each.
  const six = fixture("six-strings") as RecognizerResult;
  const bar = six.bars[2]!;
  const chord = { ...bar, beats: [{ ...bar.beats[0]!, notes: [1, 2, 3, 4, 5, 6].map((string) => ({ ...bar.beats[0]!.notes[0]!, string, ghost: true, vibrato: true, palmMute: true })) }] };
  recognizer.answer({ status: 200, body: { ...six, bars: Array.from({ length: 3000 }, () => chord), warnings: [] } });
  const id = await started(anna);
  expect(await finished(id, anna)).toMatchObject({ status: "failed", error: { code: "recognition_failed" } });
});

test("a recognition still running when the server stopped is marked interrupted as it starts again; one running as it closes is too", async () => {
  const left = await Recognition.create({ accountId: accounts.anna!, status: "running", pageCount: 1 });
  const restarted = startApp();
  await restarted.ready();
  expect(await finished(left.id, anna)).toEqual({ id: left.id, status: "failed", pages: 1, createdAt: expect.any(String), error: { code: "interrupted", params: {}, pages: [] } });
  expect((await Recognition.findByPk(left.id))!.finishedAt).not.toBeNull();

  const held = heldBack();
  recognizer.answer(held.answering);
  const closing = startApp();
  const session = await sessionOf(closing, "ben", PASSWORD);
  const id = await started(session, undefined, closing);
  await receivedCount(1);
  await closing.close();
  expect(await finished(id, ben)).toMatchObject({ status: "failed", error: { code: "interrupted" } });
  held.release(answers.recognized());
});

test("the hourly job deletes the recognitions started more than 7 days ago, with their images, by the clock of the database", async () => {
  // The interval of the job only: the clock that says how old a recognition is, is the one of the database.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const hourly = startApp();
  const session = await sessionOf(hourly, "anna", PASSWORD);
  const ids: string[] = [];
  for (const files of [[{ data: png() }, { data: jpeg() }], [{ data: webp() }]]) {
    const id = await started(session, files, hourly);
    await finished(id, session, hourly);
    ids.push(id);
  }
  const [old, recent] = ids as [string, string];
  const startedAgo = (id: string, interval: string) => sequelize.query(`UPDATE recognitions SET created_at = now() - interval '${interval}' WHERE id = $1`, { bind: [id] });
  const destroy = vi.spyOn(Recognition, "destroy");
  const nextRun = async () => {
    const runs = destroy.mock.calls.length;
    await vi.advanceTimersByTimeAsync(PURGE_INTERVAL_MS);
    // After the job's scores, by the database's time.
    await vi.waitUntil(() => destroy.mock.calls.length === runs + 1, { timeout: 5000 });
    await destroy.mock.results.at(-1)!.value;
  };

  await startedAgo(old, "6 days 23 hours");
  await nextRun();
  expect(await Recognition.count()).toBe(2);

  await startedAgo(old, "7 days 1 minute");
  await startedAgo(recent, "6 days");
  await nextRun();
  expect((await details(old, session, hourly)).statusCode).toBe(404);
  expect(await RecognitionImage.count({ where: { recognitionId: old } })).toBe(0);
  expect((await details(recent, session, hourly)).statusCode).toBe(200);
  expect(await RecognitionImage.count({ where: { recognitionId: recent } })).toBe(1);
});
