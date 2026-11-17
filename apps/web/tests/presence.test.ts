// The presence as the page has it (docs/spec/views.md, section 8): what a tab tells, what it reads
// of the others, and where it draws them. Two awarenesses wired together stand for two tabs, a
// relay between them writing the identity as the server does; no provider, no server.
import { createRequire } from "node:module";

import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { PresenceState } from "@studio/contracts";
import { addPart, barsOf, contentOf, createScore, type Cursor, cursorAt, insertBars, partsOf, type Selection, setFret } from "@studio/score-model";
import type { Rect } from "@studio/score-render";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { overlaps } from "../src/overlay";
import { joinPresence, localStateOf, membersOf, type Peer, peerCursorOf, peerMarksOf, peersOf, TAG, tagRect, tagWidth } from "../src/presence";

type Awareness = NonNullable<HocuspocusProvider["awareness"]>;

// y-protocols as the provider has it: not a dependency of the web app's own.
const awarenessProtocol = createRequire(createRequire(import.meta.url).resolve("@hocuspocus/provider"))("y-protocols/awareness") as {
  Awareness: new (doc: Y.Doc) => Awareness;
  encodeAwarenessUpdate(awareness: Awareness, clients: number[]): Uint8Array;
  applyAwarenessUpdate(awareness: Awareness, update: Uint8Array, origin: unknown): void;
};

const ANNA = { accountId: "anna", displayName: "安娜", color: "#d73a49" };
const BEN = { accountId: "ben", displayName: "班", color: "#005cc5" };

/**
 * Tabs whose awarenesses hand each other their changes, through a relay that writes each tab's
 * identity into its state as the server does (the rest is passed as it is).
 */
function tabs(...owners: (typeof ANNA)[]) {
  const all = owners.map((owner) => ({ owner, awareness: new awarenessProtocol.Awareness(new Y.Doc()) }));
  const relay = new awarenessProtocol.Awareness(new Y.Doc());
  relay.setLocalState(null);
  for (const { owner, awareness } of all) {
    awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === "relay") return;
      const clients = [...added, ...updated, ...removed];
      const scratch = new awarenessProtocol.Awareness(new Y.Doc());
      scratch.setLocalState(null);
      awarenessProtocol.applyAwarenessUpdate(scratch, awarenessProtocol.encodeAwarenessUpdate(awareness, clients), null);
      for (const [client, state] of scratch.getStates()) scratch.getStates().set(client, { ...state, ...owner });
      const update = awarenessProtocol.encodeAwarenessUpdate(scratch, clients);
      for (const other of all) if (other.awareness !== awareness) awarenessProtocol.applyAwarenessUpdate(other.awareness, update, "relay");
      awarenessProtocol.applyAwarenessUpdate(relay, update, "relay");
    });
  }
  return all.map(({ awareness }) => awareness);
}

/** A score of three bars and a guitar, and the anchors of its first beats. */
function score() {
  const doc = new Y.Doc();
  createScore(doc, "Demo");
  const barIds = insertBars(doc, { after: null, count: 3 });
  const partId = addPart(doc, { name: "Guitar", kind: "fretted" });
  let typed = cursorAt(doc, partId, barIds[0]!, 1);
  const beatIds: string[] = [];
  for (const fret of [1, 2, 3]) {
    typed = setFret(doc, { ...typed, at: "after" }, fret);
    beatIds.push(typed.beatId!);
  }
  const on = (beatId: string): Cursor => ({ ...typed, beatId, at: "on" });
  return { doc, barIds, partId, beatIds, on };
}

const peer = (clientId: number, owner: typeof ANNA, fields: Partial<PresenceState> = {}): Peer => ({ ...owner, mode: "edit", cursor: null, selection: null, ...fields, clientId });

test("a tab tells its cursor and selection in the edit views, nothing but its mode in the Read view", () => {
  const cursor: Cursor = { partId: "p", barId: "b", voice: "0:0", beatId: null, at: "after", line: 1 };
  const selection: Selection = { kind: "bars", partId: "p", anchorBarId: "b", focusBarId: "c" };
  expect(localStateOf("editable", { cursor, selection })).toEqual({ mode: "edit", cursor, selection });
  expect(localStateOf("readOnlyEdit", { cursor, selection })).toEqual({ mode: "read", cursor, selection });
  expect(localStateOf("read", { cursor, selection })).toEqual({ mode: "read", cursor: null, selection: null });
});

test("two tabs wired together: each sees the other with its identity, moves followed, and nothing of it once it leaves", () => {
  const [annaTab, benTab] = tabs(ANNA, BEN);
  const seenByBen: Peer[][] = [];
  const anna = joinPresence(annaTab!, () => undefined);
  const ben = joinPresence(benTab!, (peers) => seenByBen.push(peers));
  const cursor: Cursor = { partId: "p", barId: "b1", voice: "0:0", beatId: null, at: "after", line: 1 };
  anna.tell({ mode: "edit", cursor, selection: null });
  expect(ben.peers()).toEqual([{ ...ANNA, mode: "edit", cursor, selection: null, clientId: annaTab!.clientID }]);
  anna.tell({ mode: "edit", cursor: { ...cursor, barId: "b2" }, selection: null });
  expect(ben.peers()[0]?.cursor?.barId).toBe("b2");
  // Ben's own state is not among the others, before or after he tells it.
  ben.tell({ mode: "read", cursor: null, selection: null });
  expect(ben.peers().map((each) => each.clientId)).toEqual([annaTab!.clientID]);
  expect(anna.peers()).toEqual([{ ...BEN, mode: "read", cursor: null, selection: null, clientId: benTab!.clientID }]);

  anna.leave();
  expect(ben.peers()).toEqual([]);
  expect(seenByBen.at(-1)).toEqual([]);
  // Telling after leaving says nothing.
  anna.tell({ mode: "edit", cursor, selection: null });
  expect(ben.peers()).toEqual([]);
});

test("a member with two tabs is listed once and has two cursors; one's own account is not listed", () => {
  const [first, second, benTab] = tabs(ANNA, ANNA, BEN);
  const ben = joinPresence(benTab!, () => undefined);
  const cursor = (barId: string): Cursor => ({ partId: "p", barId, voice: "0:0", beatId: null, at: "after", line: 1 });
  joinPresence(first!, () => undefined).tell({ mode: "read", cursor: cursor("b1"), selection: null });
  joinPresence(second!, () => undefined).tell({ mode: "edit", cursor: cursor("b2"), selection: null });
  expect(ben.peers().map((each) => each.cursor?.barId)).toEqual(expect.arrayContaining(["b1", "b2"]));
  expect(membersOf(ben.peers(), "ben")).toEqual([{ ...ANNA, mode: "edit" }]);
  expect(membersOf(ben.peers(), "anna")).toEqual([]);
});

test("states not of a presence's shape, and this tab's own, are not peers", () => {
  const states = new Map<number, unknown>([
    [3, { ...BEN, mode: "edit", cursor: null, selection: null }],
    [1, { ...ANNA, mode: "edit", cursor: null, selection: null }],
    [2, {}],
    [4, { ...ANNA, mode: "edit", cursor: { bar: 1 }, selection: null }],
    [5, { ...ANNA, color: "red; background: url(x)", mode: "edit", cursor: null, selection: null }],
    [9, { ...ANNA, mode: "edit", cursor: null, selection: null }],
  ]);
  expect(peersOf(states, 9).map((each) => each.clientId)).toEqual([1, 3]);
});

test("another tab's cursor whose beat is gone lands on the last beat of its voice; none once its bar or part is gone", () => {
  const { doc, barIds, partId, beatIds, on } = score();
  expect(peerCursorOf(doc, on(beatIds[1]!))).toEqual(on(beatIds[1]!));
  contentOf(partsOf(doc).get(partId)!).get(barIds[0]!)!.get("0:0")!.delete(1, 1);
  expect(peerCursorOf(doc, on(beatIds[1]!))).toEqual(on(beatIds[2]!));
  // A line past the part's strings is kept on them.
  expect(peerCursorOf(doc, { ...on(beatIds[0]!), line: 40 })?.line).toBe(6);
  expect(peerCursorOf(doc, { ...on(beatIds[0]!), barId: "gone" })).toBeNull();
  expect(peerCursorOf(doc, { ...on(beatIds[0]!), partId: "gone" })).toBeNull();
  // No bars, then no parts: nothing to place it in, and nothing thrown.
  for (const barId of barIds) barsOf(doc).delete(barId);
  expect(peerCursorOf(doc, on(beatIds[0]!))).toBeNull();
  partsOf(doc).delete(partId);
  expect(peerCursorOf(doc, on(beatIds[0]!))).toBeNull();
});

/** A reserved area above the staff of the last bar of the first system. */
const AREA: Rect = { x: 400, y: 10, width: 80, height: 30 };

test("a name tag goes above its cursor, and below it when above is reserved or off the page", () => {
  const width = tagWidth("安娜");
  expect(width).toBe(2 * TAG.fontSize + 2 * TAG.padding);
  expect(tagWidth("x".repeat(200))).toBe(TAG.maxWidth);
  const cursor = { x: 100, y: 60, width: 10, height: 12 };
  expect(tagRect(cursor, width, [AREA])).toEqual({ x: 100, y: 60 - TAG.height - TAG.gap, width, height: TAG.height });
  const underMark = { x: 420, y: 40, width: 10, height: 12 };
  const below = tagRect(underMark, width, [AREA]);
  expect(below.y).toBe(underMark.y + underMark.height + TAG.gap);
  expect(overlaps(below, AREA)).toBe(false);
  expect(tagRect({ ...cursor, y: 5 }, width, []).y).toBe(5 + 12 + TAG.gap);
});

test("the others are drawn where their anchors are now, out of the reserved areas; what is gone is not drawn", () => {
  const { doc, barIds, partId, beatIds, on } = score();
  // A renderer that draws each beat of the first bar 30 px apart, under the reserved area, and bars as one box each.
  const renderer = {
    boundsOf: (cursor: Cursor) => {
      const index = cursor.beatId === null ? -1 : beatIds.indexOf(cursor.beatId);
      return cursor.barId === barIds[0] && index >= 0 ? { x: 400 + 30 * index, y: 35, width: 10, height: 12 } : null;
    },
    boundsOfSelection: (selection: Selection) => (selection.kind === "bars" && selection.anchorBarId === barIds[0] ? [{ x: 300, y: 35, width: 300, height: 40 }] : []),
  };
  const bars: Selection = { kind: "bars", partId, anchorBarId: barIds[0]!, focusBarId: barIds[0]! };
  const peers = [peer(1, ANNA, { cursor: on(beatIds[1]!), selection: bars }), peer(2, BEN, { mode: "read", cursor: { ...on(beatIds[0]!), barId: "gone" } }), peer(3, BEN)];
  const [anna, gone, reading] = peerMarksOf(renderer, doc, peers, [AREA]);
  expect(anna).toMatchObject({ clientId: 1, name: "安娜", color: ANNA.color, mode: "edit", at: on(beatIds[1]!) });
  // Cut at the area's bottom edge; its tag below it.
  expect(anna!.cursor).toEqual({ x: 430, y: 40, width: 10, height: 7 });
  expect(overlaps(anna!.tag!, AREA)).toBe(false);
  // The selection's box cut only where it is under the area.
  expect(anna!.selection).toEqual([
    { x: 300, y: 35, width: 100, height: 40 },
    { x: 400, y: 40, width: 80, height: 35 },
    { x: 480, y: 35, width: 120, height: 40 },
  ]);
  expect(gone).toMatchObject({ at: null, cursor: null, tag: null, selection: [] });
  expect(reading).toMatchObject({ cursor: null, tag: null, selection: [] });

  // Anna's beat removed by someone: her cursor is drawn on the last beat until she says where she went.
  contentOf(partsOf(doc).get(partId)!).get(barIds[0]!)!.get("0:0")!.delete(1, 1);
  expect(peerMarksOf(renderer, doc, peers, [AREA])[0]).toMatchObject({ at: on(beatIds[2]!), cursor: { x: 460 } });
});
