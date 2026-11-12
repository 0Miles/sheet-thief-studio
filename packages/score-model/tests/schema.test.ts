import { expect, test } from "vitest";

import { SCHEMA_VERSION } from "../src/index";

test("the schema version is a positive integer", () => {
  expect(Number.isInteger(SCHEMA_VERSION)).toBe(true);
  expect(SCHEMA_VERSION).toBeGreaterThan(0);
});
