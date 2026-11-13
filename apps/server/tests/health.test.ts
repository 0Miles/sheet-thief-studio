import { Redis } from "ioredis";
import { expect, test } from "vitest";

import { buildApp } from "../src/app";
import { TEST_REDIS_URL, testConfig } from "./support";

test("healthz answers ok", async () => {
  // Liveness does not reach Redis: the client never connects.
  const redis = new Redis(TEST_REDIS_URL, { lazyConnect: true });
  const app = buildApp({ config: testConfig(), redis, logger: false });
  const response = await app.inject({ method: "GET", url: "/healthz" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: "ok" });
  await app.close();
  redis.disconnect();
});
