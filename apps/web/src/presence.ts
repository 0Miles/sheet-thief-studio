// The presence of the members on a score, as the page has it (docs/spec/views.md, section 8): what
// this tab tells the others through the provider's awareness, what it reads of theirs, and where
// their cursors, selections and name tags are drawn. A guest takes no part in any of it. Who a
// state belongs to is the server's word (ADR 0005); a state that is not of a presence's shape is
// left out. Others' cursors are anchors in the score, placed again after every change of it.
import { type LocalPresenceState, type PresenceMode, type PresenceState, presenceState } from "@studio/contracts";
import type { LocalPresence, View } from "@studio/score-editor";
import { type Cursor, lineRange, partKindOf, partsOf, type Selection, settleCursor, stringCountOf } from "@studio/score-model";
import type { Rect, ScoreRenderer } from "@studio/score-render";
import type * as Y from "yjs";

import { clearOf, clearPieces, overlaps } from "./overlay";

/** Another tab on the score: its awareness client, and the presence the server wrote for it. */
export interface Peer extends PresenceState {
  clientId: number;
}

/** "edit" in the view one types in; "read" in the read-only edit view and the Read view. */
export function modeOf(view: View): PresenceMode {
  return view === "editable" ? "edit" : "read";
}

/** What this tab tells the others: in the Read view, no cursor and no selection. */
export function localStateOf(view: View, { cursor, selection }: LocalPresence): LocalPresenceState {
  return view === "read" ? { mode: "read", cursor: null, selection: null } : { mode: modeOf(view), cursor, selection };
}

/** The other tabs' presences, by client: this tab's own and any state not of a presence's shape left out. */
export function peersOf(states: ReadonlyMap<number, unknown>, self: number): Peer[] {
  const peers: Peer[] = [];
  for (const [clientId, state] of states) {
    if (clientId === self) continue;
    const read = presenceState.safeParse(state);
    if (read.success) peers.push({ ...read.data, clientId });
  }
  return peers.sort((a, b) => a.clientId - b.clientId);
}

/** A member on the score now, once however many tabs they have open. */
export interface PresentMember {
  accountId: string;
  displayName: string;
  color: string;
  /** "edit" when any of their tabs is in the view one types in. */
  mode: PresenceMode;
}

/** The members present, each once, in the order they are first found; not this tab's own account. */
export function membersOf(peers: readonly Peer[], self: string | null): PresentMember[] {
  const members = new Map<string, PresentMember>();
  for (const { accountId, displayName, color, mode } of peers) {
    if (accountId === self) continue;
    const known = members.get(accountId);
    if (known === undefined) members.set(accountId, { accountId, displayName, color, mode });
    else if (mode === "edit") known.mode = "edit";
  }
  return [...members.values()];
}

/**
 * Where another tab's cursor is in the score as this tab has it (docs/spec/commands.md, section
 * 2): the cursor itself while its anchors are there; on the last beat of its voice once its beat
 * is gone (this tab does not know where the beat was), until that tab says where it went; none
 * once its part, bar or voice is gone, or in a document that cannot be read. Its line kept on its part's.
 */
export function peerCursorOf(doc: Y.Doc, cursor: Cursor): Cursor | null {
  try {
    const settled = settleCursor(doc, cursor);
    const part = partsOf(doc).get(cursor.partId);
    if (settled === null || part === undefined) return null;
    const { first, last } = lineRange(partKindOf(part), stringCountOf(part));
    return { ...settled, line: Math.min(Math.max(settled.line, first), last) };
  } catch {
    return null;
  }
}

/** A name tag: its height, the room between it and the cursor, its padding and its font, in CSS pixels. */
export const TAG = { height: 16, gap: 2, padding: 4, fontSize: 11, maxWidth: 140 };

/**
 * How wide a name tag is drawn: wide enough for the name at the tag's font (a CJK character is as
 * wide as the font is tall, any other about 0.62 of it), at most `TAG.maxWidth`, the rest of a
 * longer name cut off. The tag is drawn at exactly this size, so it covers what it is said to.
 */
export function tagWidth(name: string): number {
  let text = 0;
  for (const character of name) text += (character.codePointAt(0) ?? 0) >= 0x2e80 ? TAG.fontSize : TAG.fontSize * 0.62;
  return Math.min(Math.ceil(text) + 2 * TAG.padding, TAG.maxWidth);
}

/**
 * Where a name tag goes: above its cursor, at its left edge; below the cursor when above would
 * reach into a reserved area or past the top of the page; and below any reserved area it still
 * reaches into (docs/spec/views.md, section 9). Moved, never cut: its name must be read.
 */
export function tagRect(cursor: Rect, width: number, reserved: readonly Rect[]): Rect {
  let tag: Rect = { x: cursor.x, y: cursor.y - TAG.height - TAG.gap, width, height: TAG.height };
  if (tag.y < 0 || reserved.some((area) => overlaps(tag, area))) tag = { ...tag, y: cursor.y + cursor.height + TAG.gap };
  for (const area of reserved) if (overlaps(tag, area)) tag = { ...tag, y: area.y + area.height };
  return tag;
}

/** Another tab as drawn: its cursor and its name tag, none when its place is not drawn; its selection, a box for each system. */
export interface PeerMark {
  clientId: number;
  accountId: string;
  name: string;
  color: string;
  mode: PresenceMode;
  /** The cursor drawn, by its anchors as placed here (for the e2e tests). */
  at: Cursor | null;
  cursor: Rect | null;
  tag: Rect | null;
  selection: Rect[];
}

/** Where the other tabs' cursors, name tags and selections are drawn, each out of the reserved areas. */
export function peerMarksOf(renderer: Pick<ScoreRenderer, "boundsOf" | "boundsOfSelection">, doc: Y.Doc, peers: readonly Peer[], reserved: readonly Rect[]): PeerMark[] {
  return peers.map((peer) => {
    const at = peer.cursor && peerCursorOf(doc, peer.cursor);
    const bounds = at && renderer.boundsOf(at);
    const cursor = bounds && clearOf(bounds, reserved);
    const selection = peer.selection === null ? [] : selectionBoxes(renderer, peer.selection, reserved);
    return {
      clientId: peer.clientId,
      accountId: peer.accountId,
      name: peer.displayName,
      color: peer.color,
      mode: peer.mode,
      at: cursor === null ? null : at,
      cursor,
      tag: cursor && tagRect(cursor, tagWidth(peer.displayName), reserved),
      selection,
    };
  });
}

/**
 * A selection's boxes out of the reserved areas: none when what it names is gone or not drawn. A
 * bar range's box over a whole system is cut only where it is under an area (`clearPieces`), so
 * that its other bars keep their height; a beat range's, inside one bar, as any overlay is (`clearOf`).
 */
export function selectionBoxes(renderer: Pick<ScoreRenderer, "boundsOfSelection">, selection: Selection, reserved: readonly Rect[]): Rect[] {
  const boxes = renderer.boundsOfSelection(selection);
  return selection.kind === "bars" ? boxes.flatMap((box) => clearPieces(box, reserved)) : boxes.map((box) => clearOf(box, reserved));
}

/** As much of the provider's awareness (y-protocols') as the page uses. */
export interface PresenceAwareness {
  readonly clientID: number;
  getStates(): Map<number, unknown>;
  setLocalState(state: object | null): void;
  on(event: "change", listener: () => void): void;
  off(event: "change", listener: () => void): void;
}

/** This tab in the presence of a score. */
export interface PresenceLink {
  /** Tell the others where this tab is now. */
  tell(state: LocalPresenceState): void;
  /** The other tabs, as of the last change of the awareness. */
  peers(): Peer[];
  /** This tab leaves: its state goes from everyone's awareness, and it no longer hears theirs. */
  leave(): void;
}

/** Join the presence: `onPeers` hears the other tabs every time the awareness changes. */
export function joinPresence(awareness: PresenceAwareness, onPeers: (peers: Peer[]) => void): PresenceLink {
  let peers: Peer[] = [];
  let left = false;
  const changed = () => {
    peers = peersOf(awareness.getStates(), awareness.clientID);
    onPeers(peers);
  };
  awareness.on("change", changed);
  changed();
  return {
    tell(state) {
      if (!left) awareness.setLocalState(state);
    },
    peers: () => peers,
    leave() {
      if (left) return;
      left = true;
      awareness.off("change", changed);
      awareness.setLocalState(null);
    },
  };
}
