// Every API route needs a session unless it is marked public (docs/spec/routes.md, section 1).
import { Redis } from "ioredis";
import { expect, test } from "vitest";

import { buildApp } from "../src/app";
import { ORIGIN, TEST_REDIS_URL, testConfig } from "./support";

test("an API route that is not marked public answers 401 to a request without a session", async () => {
  // Without a session cookie nothing is looked up: the client never connects.
  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
  const app = buildApp({ config: testConfig(), redis, logger: false });
  // Routes as a later ticket would add them, without asking for a session.
  app.get("/api/scores", async () => ({ scores: [] }));
  app.post("/api/scores", async () => ({ id: "new" }));
  app.get("/api/public-thing", { config: { public: true } }, async () => ({ open: true }));

  const read = await app.inject({ method: "GET", url: "/api/scores" });
  const write = await app.inject({ method: "POST", url: "/api/scores", headers: { origin: ORIGIN }, payload: {} });
  expect([read.statusCode, read.json()]).toEqual([401, { code: "unauthenticated" }]);
  expect([write.statusCode, write.json()]).toEqual([401, { code: "unauthenticated" }]);
  expect((await app.inject({ method: "GET", url: "/api/public-thing" })).json()).toEqual({ open: true });
  // Outside the API nothing is asked.
  expect((await app.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);

  await app.close();
  redis.disconnect();
});
