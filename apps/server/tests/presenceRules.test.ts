// The server's rules of the presence (docs/spec/views.md, section 8), as plain functions: the
// colour of a member, a state rebuilt from what a tab sent, the clients a connection speaks for.
// No database, no provider: tests/presence.test.ts runs them through real connections.
import { randomUUID } from "node:crypto";

import { expect, test } from "vitest";

import { clientsAllowed, colorOf, fnv1a, PRESENCE_PALETTE, presenceOf, screenAwareness } from "../src/presence";

test("FNV-1a is the 32-bit one, over the UTF-8 bytes", () => {
  expect(fnv1a("")).toBe(0x811c9dc5);
  expect(fnv1a("a")).toBe(0xe40c292c);
  expect(fnv1a("foobar")).toBe(0xbf9cf968);
  expect(fnv1a("é")).toBe(fnv1a("é"));
});

test("a member's colour is one of the eight, the same every time, and is the hash mod 8", () => {
  const ids = Array.from({ length: 200 }, () => randomUUID());
  for (const id of ids) {
    expect(PRESENCE_PALETTE).toContain(colorOf(id));
    expect(colorOf(id)).toBe(colorOf(id));
    expect(colorOf(id)).toBe(PRESENCE_PALETTE[fnv1a(id) % 8]);
  }
  // Two hundred members spread over every colour.
  expect(new Set(ids.map(colorOf)).size).toBe(8);
  expect(PRESENCE_PALETTE).toEqual(["#d73a49", "#22863a", "#005cc5", "#e36209", "#6f42c1", "#0598bc", "#b31d8f", "#8a6d3b"]);
});

const ANNA = { accountId: "a6f0c3a4-0000-4000-8000-000000000001", displayName: "安娜" };
const CURSOR = { partId: "p1", barId: "b1", voice: "0:0", beatId: null, at: "after", line: 1 } as const;

test("a state is rebuilt with the connection's identity, whatever the tab wrote there", () => {
  const sent = { accountId: "someone-else", displayName: "冒名", color: "#000000", mode: "edit", cursor: CURSOR, selection: null, huge: "x".repeat(10_000) };
  expect(presenceOf(sent, ANNA, false)).toEqual({ ...ANNA, color: colorOf(ANNA.accountId), mode: "edit", cursor: CURSOR, selection: null });
});

test("a cursor or a selection not of its shape is none; a mode not known, or a read-only connection, is read", () => {
  const rebuilt = presenceOf({ mode: "admin", cursor: { bar: 1 }, selection: { kind: "beats", partId: "p1" } }, ANNA, false);
  expect(rebuilt).toMatchObject({ mode: "read", cursor: null, selection: null });
  expect(presenceOf({ mode: "edit", cursor: { ...CURSOR, x: 10, y: 20 } }, ANNA, true)).toMatchObject({ mode: "read", cursor: CURSOR });
  expect(presenceOf({ cursor: { ...CURSOR, barId: "b".repeat(65) } }, ANNA, false).cursor).toBeNull();
  expect(presenceOf({ cursor: { ...CURSOR, line: 1.5 } }, ANNA, false).cursor).toBeNull();
  for (const nothing of [null, undefined, 3, "state", []]) expect(presenceOf(nothing, ANNA, false)).toMatchObject({ ...ANNA, mode: "read", cursor: null, selection: null });
  const bars = { kind: "bars", partId: "p1", anchorBarId: "b1", focusBarId: "b3" } as const;
  expect(presenceOf({ mode: "edit", selection: { ...bars, extra: 1 } }, ANNA, false).selection).toEqual(bars);
});

test("a connection speaks for the first client it names and for no other, never for another connection's", () => {
  const none = new Set<number>();
  expect(clientsAllowed(none, none, [7])).toEqual(new Set([7]));
  expect(clientsAllowed(none, none, [7, 8])).toEqual(new Set([7]));
  expect(clientsAllowed(new Set([7]), none, [8, 7])).toEqual(new Set([7]));
  expect(clientsAllowed(none, new Set([7]), [7, 8])).toEqual(new Set([8]));
  expect(clientsAllowed(new Set([7]), new Set([8]), [8])).toEqual(new Set());
});

/** An update naming these clients' states and removals, as `beforeHandleAwareness` is handed it. */
function update(states: [number, unknown][], removed: number[]) {
  return { states: new Map<number, unknown>(states), removedClients: new Set(removed) };
}

test("from a member, only their own client is applied, its state rebuilt; another's state and removal are dropped", () => {
  const sent = update(
    [
      [7, { accountId: "someone-else", mode: "edit", cursor: CURSOR }],
      [8, { mode: "edit" }],
    ],
    [9],
  );
  screenAwareness({ who: { kind: "member", ...ANNA }, readOnly: false, own: new Set([7]), others: new Set([8, 9]) }, sent.states, sent.removedClients);
  expect([...sent.states]).toEqual([[7, { ...ANNA, color: colorOf(ANNA.accountId), mode: "edit", cursor: CURSOR, selection: null }]]);
  expect([...sent.removedClients]).toEqual([]);
  // Its own removal goes through; a read-only connection is in read mode.
  const own = update([], [7]);
  screenAwareness({ who: { kind: "member", ...ANNA }, readOnly: true, own: new Set([7]), others: new Set() }, own.states, own.removedClients);
  expect([...own.removedClients]).toEqual([7]);
  const reading = update([[7, { mode: "edit" }]], []);
  screenAwareness({ who: { kind: "member", ...ANNA }, readOnly: true, own: new Set([7]), others: new Set() }, reading.states, reading.removedClients);
  expect(reading.states.get(7)).toMatchObject({ mode: "read" });
});

test("from a guest, or from a connection the server cannot tell, nothing is applied", () => {
  for (const who of [{ kind: "guest" } as const, undefined]) {
    const sent = update([[7, { ...ANNA, color: "#d73a49", mode: "edit", cursor: CURSOR, selection: null }]], [8]);
    screenAwareness({ who, readOnly: false, own: new Set(), others: new Set([8]) }, sent.states, sent.removedClients);
    expect(sent.states.size).toBe(0);
    expect(sent.removedClients.size).toBe(0);
  }
});
