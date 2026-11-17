// Password hashes (docs/spec/security.md, section 3).
import { expect, test } from "vitest";

import { hashPassword, verifyPassword } from "../src/passwords";

test("a password is hashed with argon2id, 19456 KiB, 2 passes, 1 lane, and only that password matches", async () => {
  const hashed = await hashPassword("a password long enough");
  expect(hashed.startsWith("$argon2id$v=19$m=19456,t=2,p=1$")).toBe(true);
  expect(await verifyPassword(hashed, "a password long enough")).toBe(true);
  expect(await verifyPassword(hashed, "another password")).toBe(false);
  expect(await verifyPassword("not a hash", "a password long enough")).toBe(false);
});
