// Collab tickets read back from Redis (docs/spec/collab.md, section 3): what is stored is read by
// the fields of a ticket, and a value that is not one counts as no ticket.
import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { CollabTickets, TICKET_TTL_SECONDS } from "../src/collabTickets";
import { newToken } from "../src/tokens";
import { freshRedis } from "./support";

let redis: Redis;
let tickets: CollabTickets;

beforeAll(async () => {
  redis = await freshRedis();
  tickets = new CollabTickets(redis);
});

beforeEach(async () => {
  await redis.flushdb();
});

afterAll(async () => {
  await redis.quit();
});

const member = { kind: "member", scoreId: "score-1", accountId: "account-1", sessionId: "session-1", role: "editor" } as const;
const guest = { kind: "guest", scoreId: "score-1", linkToken: "link-1" } as const;

/** A ticket whose stored value is this text, as an older server or a hand in Redis may have left it. */
async function stored(value: string): Promise<string> {
  const ticket = newToken();
  await redis.set(`collab-ticket:${ticket}`, value, "EX", TICKET_TTL_SECONDS);
  return ticket;
}

test("a member's and a guest's ticket come back as they were given, once", async () => {
  for (const given of [member, guest]) {
    const ticket = await tickets.issue(given);
    expect(await tickets.redeem(ticket)).toEqual(given);
    expect(await tickets.redeem(ticket)).toBeNull();
  }
});

test.each([
  ["is not JSON", "not JSON"],
  ["is not an object", JSON.stringify("member")],
  ["is null", "null"],
  ["has no score", JSON.stringify({ ...member, scoreId: undefined })],
  ["has a score id that is no string", JSON.stringify({ ...member, scoreId: 1 })],
  ["is of no kind it knows", JSON.stringify({ ...member, kind: "admin" })],
  ["is a member's without a session", JSON.stringify({ ...member, sessionId: undefined })],
  ["is a member's without an account", JSON.stringify({ ...member, accountId: undefined })],
  ["is a member's with a role there is not", JSON.stringify({ ...member, role: "admin" })],
  ["is a guest's without a link", JSON.stringify({ ...guest, linkToken: undefined })],
  ["has its fields only under __proto__", `{"__proto__": ${JSON.stringify(member)}}`],
])("a ticket whose stored value %s counts as none, and is used up all the same", async (_, value) => {
  const ticket = await stored(value);
  expect(await tickets.redeem(ticket)).toBeNull();
  expect(await redis.exists(`collab-ticket:${ticket}`)).toBe(0);
});

test("a ticket is read by its own fields: others that were stored with it are left out", async () => {
  const ticket = await stored(JSON.stringify({ ...member, linkToken: "link-1", isAdmin: true }));
  expect(await tickets.redeem(ticket)).toEqual(member);
});

test("a ticket with a field of its own named __proto__ is read without it, and the prototype is left alone", async () => {
  const ticket = await stored(`{"__proto__": {"role": "owner", "isAdmin": true}, ${JSON.stringify(member).slice(1)}`);
  const read = await tickets.redeem(ticket);
  expect(read).toEqual(member);
  expect(Object.hasOwn(read!, "__proto__")).toBe(false);
  expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
  expect((read as { isAdmin?: unknown }).isAdmin).toBeUndefined();
  expect(({} as { isAdmin?: unknown }).isAdmin).toBeUndefined();
});
