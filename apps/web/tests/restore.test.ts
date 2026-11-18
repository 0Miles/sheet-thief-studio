// The restore flow of the versions page (docs/spec/collab.md, 8.5), with a fake fetch: the version
// before is made first, and the version is written over the score only once it has been.
import { SCHEMA_VERSION, type ScoreJSON } from "@studio/score-model";
import { afterEach, expect, test, vi } from "vitest";

import { ApiError } from "../src/api";
import { restoreVersion, type RestoreTarget } from "../src/restore";

const SCORE_ID = "score-1";
const VERSION_ID = "version-1";
const VERSION: ScoreJSON = { schemaVersion: SCHEMA_VERSION, title: "那時候", bars: [{ id: "b", timeSig: { numerator: 4, denominator: 4 } }], parts: [] };

/** What the server answers each call, by method and path; the calls made, in order. */
function fakeServer(answers: Record<string, () => Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string, init?: RequestInit) => {
      const call = `${init?.method ?? "GET"} ${path}`;
      calls.push(init?.body === undefined ? call : `${call} ${String(init.body)}`);
      const answer = answers[call];
      if (answer === undefined) throw new Error(`no answer for ${call}`);
      return answer();
    }),
  );
  return calls;
}

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function target(open = true) {
  const written: ScoreJSON[] = [];
  const restoreTarget: RestoreTarget = {
    canRestore: () => open,
    replace: (version) => {
      written.push(version);
      return true;
    },
  };
  return { restoreTarget, written };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("the version before is made, then the version read and written over the score", async () => {
  const calls = fakeServer({
    [`POST /api/scores/${SCORE_ID}/versions`]: json(201, { versionId: "before" }),
    [`GET /api/scores/${SCORE_ID}/versions/${VERSION_ID}`]: json(200, VERSION),
  });
  const { restoreTarget, written } = target();
  expect(await restoreVersion(SCORE_ID, VERSION_ID, restoreTarget)).toBe("restored");
  expect(calls).toEqual([`POST /api/scores/${SCORE_ID}/versions {}`, `GET /api/scores/${SCORE_ID}/versions/${VERSION_ID}`]);
  expect(written).toEqual([VERSION]);
});

test.each([
  [403, "forbidden"],
  [404, "not_found"],
  [409, "score_read_only"],
  [500, "internal_error"],
] as const)("when the version before cannot be made (%i), the version is neither read nor written", async (status, code) => {
  const calls = fakeServer({ [`POST /api/scores/${SCORE_ID}/versions`]: json(status, { code }) });
  const { restoreTarget, written } = target();
  const failed = restoreVersion(SCORE_ID, VERSION_ID, restoreTarget);
  await expect(failed).rejects.toEqual(new ApiError(status, code));
  expect(calls).toHaveLength(1);
  expect(written).toEqual([]);
});

test("a network failure on the way is no restore either", async () => {
  fakeServer({ [`POST /api/scores/${SCORE_ID}/versions`]: () => Promise.reject(new TypeError("Failed to fetch")) as never });
  const { restoreTarget, written } = target();
  await expect(restoreVersion(SCORE_ID, VERSION_ID, restoreTarget)).rejects.toThrow("Failed to fetch");
  expect(written).toEqual([]);
});

test("a version that cannot be read is not written, the version before it kept", async () => {
  const calls = fakeServer({
    [`POST /api/scores/${SCORE_ID}/versions`]: json(200, { versionId: "latest" }),
    [`GET /api/scores/${SCORE_ID}/versions/${VERSION_ID}`]: json(409, { code: "version_unreadable" }),
  });
  const { restoreTarget, written } = target();
  await expect(restoreVersion(SCORE_ID, VERSION_ID, restoreTarget)).rejects.toEqual(new ApiError(409, "version_unreadable"));
  expect(calls).toHaveLength(2);
  expect(written).toEqual([]);
});

test("while the score is not open here, nothing is asked of the server", async () => {
  const calls = fakeServer({});
  const { restoreTarget, written } = target(false);
  expect(await restoreVersion(SCORE_ID, VERSION_ID, restoreTarget)).toBe("notOpen");
  expect(calls).toEqual([]);
  expect(written).toEqual([]);
});
