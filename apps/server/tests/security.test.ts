// The headers of every answer, the body limit, and the build of the web app served by the server
// (docs/spec/security.md, sections 5 to 7). No test here reaches Redis or Postgres.
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { afterEach, expect, test } from "vitest";

import { buildApp } from "../src/app";
import { ORIGIN, TEST_REDIS_URL, testConfig } from "./support";

/** A build as Vite leaves one: the page, and a file of /assets/ named after its content. */
const BUILD = fileURLToPath(new URL("fixtures/web", import.meta.url));
const PAGE = readFileSync(`${BUILD}/index.html`, "utf8");

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

let closing: Array<() => Promise<unknown> | void> = [];

afterEach(async () => {
  for (const close of closing) await close();
  closing = [];
});

/** An app whose Redis client never connects: nothing here gets as far as a session. */
function startApp(env: NodeJS.ProcessEnv = {}): FastifyInstance {
  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
  const app = buildApp({ config: testConfig(env), redis, logger: false });
  closing.push(
    () => app.close(),
    () => redis.disconnect(),
  );
  return app;
}

test("every answer carries the security headers: an answer, a refusal, an unknown path", async () => {
  const app = startApp();
  const answers = [
    await app.inject({ method: "GET", url: "/healthz" }),
    await app.inject({ method: "GET", url: "/api/me" }),
    await app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: "https://elsewhere.test" }, payload: {} }),
    await app.inject({ method: "GET", url: "/api/nothing-here" }),
  ];
  expect(answers.map((answer) => answer.statusCode)).toEqual([200, 401, 403, 404]);
  for (const { headers } of answers) {
    expect(headers["content-security-policy"]).toBe(CSP);
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["permissions-policy"]).toBe("camera=(), microphone=(), geolocation=()");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(headers["x-robots-tag"]).toBe("noindex");
    expect(headers["cache-control"]).toBe("no-store");
    expect(headers["strict-transport-security"]).toBeUndefined();
  }
});

test("HSTS is sent only when the configuration turns it on", async () => {
  const app = startApp({ HSTS: "1" });
  const answer = await app.inject({ method: "GET", url: "/healthz" });
  expect(answer.headers["strict-transport-security"]).toBe("max-age=31536000; includeSubDomains");
});

test("a body over the limit is refused with 413, whether the request says its length or not", async () => {
  const app = startApp();
  const body = JSON.stringify({ username: "anna", password: "x".repeat(64 * 1024) });
  const headers = { origin: ORIGIN, "content-type": "application/json" };
  const declared = await app.inject({ method: "POST", url: "/api/auth/login", headers, payload: body });
  expect([declared.statusCode, declared.json()]).toEqual([413, { code: "payload_too_large" }]);
  // Without Content-Length: counted as it is read.
  const streamed = await app.inject({ method: "POST", url: "/api/auth/login", headers, payload: Readable.from([Buffer.from(body)]) });
  expect([streamed.statusCode, streamed.json()]).toEqual([413, { code: "payload_too_large" }]);
});

test("the server serves the build: the page with the CSP, not cached; a file of /assets/ cached for good", async () => {
  const app = startApp({ WEB_ROOT: BUILD });
  for (const url of ["/", "/login", "/scores/3f0e8a52-6f0f-4a53-9d0c-0f6f0a1b2c3d", "/index.html"]) {
    const page = await app.inject({ method: "GET", url });
    expect([url, page.statusCode, page.body]).toEqual([url, 200, PAGE]);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-security-policy"]).toBe(CSP);
    expect(page.headers["cache-control"]).toBe("no-cache");
  }
  const asset = await app.inject({ method: "GET", url: "/assets/app-1a2b3c4d.js" });
  expect(asset.statusCode).toBe(200);
  expect(asset.body).toContain("fixture");
  expect(asset.headers["content-type"]).toBe("text/javascript; charset=utf-8");
  expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect(asset.headers["x-content-type-options"]).toBe("nosniff");
  const head = await app.inject({ method: "HEAD", url: "/" });
  expect([head.statusCode, head.body, head.headers["content-security-policy"]]).toEqual([200, "", CSP]);
});

test("the page of a read-only link sends no referrer on and is not indexed", async () => {
  const app = startApp({ WEB_ROOT: BUILD });
  const page = await app.inject({ method: "GET", url: "/s/anything-at-all" });
  expect([page.statusCode, page.body]).toEqual([200, PAGE]);
  expect(page.headers["referrer-policy"]).toBe("no-referrer");
  expect(page.headers["x-robots-tag"]).toBe("noindex");
  expect(page.headers["content-security-policy"]).toBe(CSP);
});

test("the page stands in for no API path, no missing file of the build, and nothing outside the build", async () => {
  const app = startApp({ WEB_ROOT: BUILD });
  // An unknown API path is a 404 in the API's shape, however it is spelled; /collab is no page either.
  for (const url of ["/api", "/api/", "/api/nothing-here", "/%61pi/nothing-here", "/collab", "/collab/x", "/assets/missing-00000000.js"]) {
    const answer = await app.inject({ method: "GET", url });
    expect([url, answer.statusCode, answer.json()]).toEqual([url, 404, { code: "not_found" }]);
    expect(answer.headers["cache-control"]).not.toContain("immutable");
  }
  // The API still asks for a session.
  expect((await app.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(401);
  // Climbing out of the build reaches no file: inside /assets/ nothing, elsewhere the page.
  for (const url of ["/assets/..%2F..%2Fsupport.ts", "/assets/..%5C..%5Csupport.ts"]) {
    expect([url, (await app.inject({ method: "GET", url })).statusCode]).toEqual([url, 404]);
  }
  for (const url of ["/..%2F..%2Fsupport.ts", "/%2e%2e/support.ts", "/assets/%2e%2e/%2e%2e/support.ts", "/.env"]) {
    const answer = await app.inject({ method: "GET", url });
    expect([url, answer.statusCode, answer.body]).toEqual([url, 200, PAGE]);
  }
  // Only reading: nothing else is a page.
  const write = await app.inject({ method: "POST", url: "/login", headers: { origin: ORIGIN }, payload: {} });
  expect([write.statusCode, write.json()]).toEqual([404, { code: "not_found" }]);
});

test("without a build to serve, the server answers no page", async () => {
  const app = startApp();
  const answer = await app.inject({ method: "GET", url: "/" });
  expect([answer.statusCode, answer.json()]).toEqual([404, { code: "not_found" }]);
});
