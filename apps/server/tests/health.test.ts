import { expect, test } from "vitest";

import { buildApp } from "../src/app";

test("healthz answers ok", async () => {
  const app = buildApp();
  const response = await app.inject({ method: "GET", url: "/healthz" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: "ok" });
  await app.close();
});
