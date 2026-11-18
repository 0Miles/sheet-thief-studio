// Saving a phrase from the phrase editor (docs/spec/phrases.md, 5.1): a PUT of the whole fragment
// once editing stops for a second, one request on the way at a time, the two cases of 409, and
// 413. The server is a stand-in for `fetch` that answers when the test says; the clock is vitest's.
import { type BarsFragment, blankFragment, PART_PRESETS } from "@studio/score-model";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { createPhraseSaver, MAX_RETRIES, MAX_RETRY_DELAY_MS, type PhraseSaver, RETRY_DELAY_MS, SAVE_DELAY_MS, type SaveState } from "../src/phraseSaver";

/** A request the page sent, waiting for the test to answer it. */
interface Sent {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  answered: boolean;
  answer(status: number, body?: unknown, headers?: Record<string, string>): void;
  /** The network lost it: no answer at all. */
  lose(): void;
}

let sent: Sent[];

function fakeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request: Sent = {
      method: init.method ?? "GET",
      path,
      body: typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      answered: false,
      answer(status, body = {}, headers = {}) {
        request.answered = true;
        resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } }));
      },
      lose() {
        request.answered = true;
        reject(new TypeError("Failed to fetch"));
      },
    };
    sent.push(request);
  });
}

/** The requests still on their way. */
const onTheWay = () => sent.filter((request) => !request.answered);
/** The latest request sent. */
const last = () => sent.at(-1)!;
/** Let the page go on with an answer it was given. */
const settle = () => vi.advanceTimersByTimeAsync(0);

/** A blank guitar phrase whose one bar is `beats`/4: fragments that differ from one another. */
function fragmentOf(beats: number): BarsFragment {
  const fragment = blankFragment(PART_PRESETS.guitar6);
  return { ...fragment, bars: [{ ...fragment.bars[0]!, timeSig: { numerator: beats, denominator: 4 } }] } as BarsFragment;
}

const ID = "11111111-1111-4111-8111-111111111111";
let saver: PhraseSaver;
let states: SaveState[];

function open(revision = 1): void {
  saver = createPhraseSaver({ id: ID, revision, name: "主歌", fragment: fragmentOf(4) });
  states = [];
  saver.onState((state) => states.push(state));
}

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  open();
});

afterEach(() => {
  saver.destroy();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test("the whole fragment is put once editing stops for a second, from the revision the page has", async () => {
  saver.edit(fragmentOf(3));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 1);
  saver.edit(fragmentOf(5));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS - 1);
  expect(sent).toEqual([]);
  expect(saver.state).toBe("waiting");
  expect(saver.unsaved()).toBe(true);

  await vi.advanceTimersByTimeAsync(1);
  expect(sent).toHaveLength(1);
  expect(last()).toMatchObject({ method: "PUT", path: `/api/phrases/${ID}`, body: { fragment: fragmentOf(5), baseRevision: 1 } });
  expect(saver.state).toBe("saving");
  expect(saver.unsaved()).toBe(true);

  last().answer(200, { revision: 2 });
  await settle();
  expect(saver.state).toBe("saved");
  expect(saver.revision).toBe(2);
  expect(saver.unsaved()).toBe(false);
  // Nothing more to send.
  await vi.advanceTimersByTimeAsync(10 * SAVE_DELAY_MS);
  expect(sent).toHaveLength(1);
});

test("one request on its way at a time: the edits made meanwhile go as the latest content, once it is back, from its revision", async () => {
  saver.edit(fragmentOf(3));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  expect(onTheWay()).toHaveLength(1);

  saver.edit(fragmentOf(5));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  saver.edit(fragmentOf(6));
  saver.edit(fragmentOf(7));
  await vi.advanceTimersByTimeAsync(5 * SAVE_DELAY_MS);
  expect(sent).toHaveLength(1);

  sent[0]!.answer(200, { revision: 2 });
  await settle();
  expect(sent).toHaveLength(2);
  expect(last().body).toEqual({ fragment: fragmentOf(7), baseRevision: 2 });
  last().answer(200, { revision: 3 });
  await settle();
  expect(saver.state).toBe("saved");
  expect(sent).toHaveLength(2);
});

test("an edit made while a request is on its way still waits for its second of quiet", async () => {
  saver.edit(fragmentOf(3));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  saver.edit(fragmentOf(5));
  sent[0]!.answer(200, { revision: 2 });
  await settle();
  expect(sent).toHaveLength(1);
  expect(saver.state).toBe("waiting");
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  expect(last().body).toEqual({ fragment: fragmentOf(5), baseRevision: 2 });
});

test("409 for what the server holds already (an answer lost on the way): the server's revision is taken, nothing said", async () => {
  saver.edit(fragmentOf(3));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  // The first put reached the server, its answer did not.
  sent[0]!.lose();
  await settle();
  expect(saver.state).toBe("failed");
  await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS);
  expect(last().body).toEqual({ fragment: fragmentOf(3), baseRevision: 1 });
  last().answer(409, { code: "revision_conflict" });
  await settle();

  // The page reads the phrase once; the same content, its keys in another order.
  expect(last()).toMatchObject({ method: "GET", path: `/api/phrases/${ID}` });
  const fragment = fragmentOf(3);
  last().answer(200, { revision: 2, updatedAt: "2026-11-18T00:00:00.000Z", fragment: { bars: fragment.bars, tuning: (fragment as { tuning: number[] }).tuning, kind: "fretted" }, name: "主歌", id: ID });
  await settle();
  expect(saver.state).toBe("saved");
  expect(saver.revision).toBe(2);
  expect(states).not.toContain("conflict");

  saver.edit(fragmentOf(5));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  expect(last().body).toEqual({ fragment: fragmentOf(5), baseRevision: 2 });
});

test("409 for an earlier content whose answer was lost, sent again as a newer one: the server's revision is taken, nothing said, and the newer content follows", async () => {
  saver.edit(fragmentOf(3));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  // The put of 3/4 reached the server, its answer did not; 5/4 is typed before it is tried again.
  sent[0]!.lose();
  await settle();
  saver.edit(fragmentOf(5));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  expect(last().body).toEqual({ fragment: fragmentOf(5), baseRevision: 1 });
  last().answer(409, { code: "revision_conflict" });
  await settle();
  last().answer(200, { id: ID, name: "主歌", fragment: fragmentOf(3), revision: 2, updatedAt: "2026-11-18T00:00:00.000Z" });
  await settle();
  expect(states).not.toContain("conflict");
  expect(saver.revision).toBe(2);
  expect(last()).toMatchObject({ method: "PUT", body: { fragment: fragmentOf(5), baseRevision: 2 } });
  last().answer(200, { revision: 3 });
  await settle();
  expect(saver.state).toBe("saved");
});

test("409 for other content: the phrase was changed elsewhere, and nothing more is sent; the content here is kept", async () => {
  saver.edit(fragmentOf(3));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  last().answer(409, { code: "revision_conflict" });
  await settle();
  last().answer(200, { id: ID, name: "主歌", fragment: fragmentOf(6), revision: 2, updatedAt: "2026-11-18T00:00:00.000Z" });
  await settle();
  expect(saver.state).toBe("conflict");
  expect(saver.unsaved()).toBe(true);

  saver.edit(fragmentOf(5));
  await vi.advanceTimersByTimeAsync(10 * SAVE_DELAY_MS);
  expect(sent).toHaveLength(2);
  expect(saver.state).toBe("conflict");
  expect(saver.content.fragment).toEqual(fragmentOf(5));
});

test("409 where only the name differs is a change made elsewhere too", async () => {
  saver.edit(fragmentOf(3));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  last().answer(409, { code: "revision_conflict" });
  await settle();
  last().answer(200, { id: ID, name: "副歌", fragment: fragmentOf(3), revision: 2, updatedAt: "2026-11-18T00:00:00.000Z" });
  await settle();
  expect(saver.state).toBe("conflict");
});

test("413: the phrase is too large, the content is kept here, and the next edit is sent again", async () => {
  saver.edit(fragmentOf(3));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  last().answer(413, { code: "phrase_too_large" });
  await settle();
  expect(saver.state).toBe("tooLarge");
  expect(saver.unsaved()).toBe(true);
  expect(saver.content.fragment).toEqual(fragmentOf(3));
  // Not sent again by itself.
  await vi.advanceTimersByTimeAsync(10 * RETRY_DELAY_MS);
  expect(sent).toHaveLength(1);

  saver.edit(fragmentOf(2));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  expect(last().body).toEqual({ fragment: fragmentOf(2), baseRevision: 1 });
  last().answer(200, { revision: 2 });
  await settle();
  expect(saver.state).toBe("saved");
});

test("a new name is patched at once, after the fragment waiting to go: each from the revision the answer before it gave", async () => {
  saver.edit(fragmentOf(3));
  saver.rename("副歌");
  expect(last().body).toEqual({ fragment: fragmentOf(3), baseRevision: 1 });
  last().answer(200, { revision: 2 });
  await settle();
  expect(last()).toMatchObject({ method: "PATCH", path: `/api/phrases/${ID}`, body: { name: "副歌", baseRevision: 2 } });
  expect(saver.unsaved()).toBe(true);
  last().answer(200, { revision: 3 });
  await settle();
  expect(saver.state).toBe("saved");
  expect(saver.content).toEqual({ name: "副歌", fragment: fragmentOf(3) });
});

test("the server being out of reach: the same content is tried again, from the same revision", async () => {
  saver.edit(fragmentOf(3));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  last().answer(503, { code: "internal_error" });
  await settle();
  expect(saver.state).toBe("failed");
  await vi.advanceTimersByTimeAsync(RETRY_DELAY_MS - 1);
  expect(sent).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(last().body).toEqual({ fragment: fragmentOf(3), baseRevision: 1 });
});

test("saving as a new phrase posts the content as it is here, under the name given", async () => {
  saver.edit(fragmentOf(3));
  const made = saver.saveAsNew("主歌 2");
  await settle();
  const post = sent.find((request) => request.method === "POST")!;
  expect(post).toMatchObject({ path: "/api/phrases", body: { name: "主歌 2", fragment: fragmentOf(3) } });
  post.answer(201, { id: "22222222-2222-4222-8222-222222222222", revision: 1 });
  await expect(made).resolves.toBe("22222222-2222-4222-8222-222222222222");
});

/** The phrase as the server holds it, as `GET /api/phrases/:id` answers. */
function details(beats: number, revision: number, name = "主歌") {
  return { id: ID, name, fragment: fragmentOf(beats), revision, updatedAt: "2026-11-18T00:00:00.000Z" };
}

test("409 and the phrase cannot be read: not known to be changed elsewhere, nothing more sent until the member asks to check again", async () => {
  saver.edit(fragmentOf(3));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  last().answer(409, { code: "revision_conflict" });
  await settle();
  last().lose();
  await settle();
  expect(saver.state).toBe("unchecked");
  expect(saver.unsaved()).toBe(true);
  expect(sent).toHaveLength(2);

  saver.edit(fragmentOf(5));
  await vi.advanceTimersByTimeAsync(20 * MAX_RETRY_DELAY_MS);
  expect(sent).toHaveLength(2);
  expect(saver.state).toBe("unchecked");

  // Checked again: the server holds what was sent (its own revision), and the latest edit follows.
  saver.retry();
  expect(last()).toMatchObject({ method: "GET", path: `/api/phrases/${ID}` });
  last().answer(200, details(3, 2));
  await settle();
  expect(last()).toMatchObject({ method: "PUT", body: { fragment: fragmentOf(5), baseRevision: 2 } });
  last().answer(200, { revision: 3 });
  await settle();
  expect(saver.state).toBe("saved");
});

test("checked again after a 409 that could not be looked into, the phrase holds other content: changed elsewhere", async () => {
  saver.edit(fragmentOf(3));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  last().answer(409, { code: "revision_conflict" });
  await settle();
  last().answer(503, { code: "internal_error" });
  await settle();
  expect(saver.state).toBe("unchecked");
  saver.retry();
  last().answer(200, details(6, 2));
  await settle();
  expect(saver.state).toBe("conflict");
});

test("tried again by itself after waiting twice as long each time, at most a minute, and no more than MAX_RETRIES times", async () => {
  saver.edit(fragmentOf(3));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  const waits = [5_000, 10_000, 20_000, 40_000, 60_000];
  expect(waits).toHaveLength(MAX_RETRIES);
  for (const waited of waits) {
    last().answer(503, { code: "internal_error" });
    await settle();
    expect(saver.retrying).toBe(true);
    const before = sent.length;
    await vi.advanceTimersByTimeAsync(waited - 1);
    expect(sent).toHaveLength(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(before + 1);
  }
  last().answer(503, { code: "internal_error" });
  await settle();
  expect(saver.state).toBe("failed");
  expect(saver.retrying).toBe(false);
  await vi.advanceTimersByTimeAsync(10 * MAX_RETRY_DELAY_MS);
  expect(sent).toHaveLength(MAX_RETRIES + 1);

  // The member asks: sent at once.
  saver.retry();
  expect(sent).toHaveLength(MAX_RETRIES + 2);
  last().answer(200, { revision: 2 });
  await settle();
  expect(saver.state).toBe("saved");
});

test("429: tried again once as long as its Retry-After says has passed", async () => {
  saver.edit(fragmentOf(3));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  last().answer(429, { code: "rate_limited" }, { "retry-after": "30" });
  await settle();
  expect(saver.state).toBe("failed");
  expect(saver.error).toBe("rate_limited");
  await vi.advanceTimersByTimeAsync(30_000 - 1);
  expect(sent).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(last().body).toEqual({ fragment: fragmentOf(3), baseRevision: 1 });
});

test("a refusal that is not worth trying again (404) waits for the member or the next edit", async () => {
  saver.edit(fragmentOf(3));
  await vi.advanceTimersByTimeAsync(SAVE_DELAY_MS);
  last().answer(404, { code: "not_found" });
  await settle();
  expect(saver.state).toBe("failed");
  expect(saver.retrying).toBe(false);
  expect(saver.error).toBe("not_found");
  await vi.advanceTimersByTimeAsync(10 * MAX_RETRY_DELAY_MS);
  expect(sent).toHaveLength(1);
});

test("flushing sends what waits for its second of quiet at once, and says when the server has it all", async () => {
  saver.edit(fragmentOf(3));
  const flushed = saver.flush();
  expect(last()).toMatchObject({ method: "PUT", body: { fragment: fragmentOf(3), baseRevision: 1 } });
  saver.edit(fragmentOf(5));
  const again = saver.flush();
  sent[0]!.answer(200, { revision: 2 });
  await settle();
  expect(last()).toMatchObject({ method: "PUT", body: { fragment: fragmentOf(5), baseRevision: 2 } });
  last().answer(200, { revision: 3 });
  await expect(flushed).resolves.toBe(true);
  await expect(again).resolves.toBe(true);
  await expect(saver.flush()).resolves.toBe(true);
});

test("flushing says false as soon as the content cannot be saved: changed elsewhere, or out of reach", async () => {
  saver.edit(fragmentOf(3));
  const lost = saver.flush();
  last().lose();
  await expect(lost).resolves.toBe(false);

  const conflicting = saver.flush();
  last().answer(409, { code: "revision_conflict" });
  await settle();
  last().answer(200, details(6, 2));
  await expect(conflicting).resolves.toBe(false);
  expect(saver.state).toBe("conflict");
  await expect(saver.flush()).resolves.toBe(false);
});
