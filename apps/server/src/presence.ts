// The presence of the members on a score, as the server writes it (docs/spec/views.md, section 8;
// docs/spec/collab.md, section 5; ADR 0005): who a state belongs to is the connection's, never
// what the client said, and only the fields of a presence are passed on, each of its shape.
import { type PresenceState, presenceCursor, presenceMode, presenceSelection } from "@studio/contracts";

/** The eight colours of the members, in the order the hash picks them (docs/spec/views.md, section 8). */
export const PRESENCE_PALETTE = ["#d73a49", "#22863a", "#005cc5", "#e36209", "#6f42c1", "#0598bc", "#b31d8f", "#8a6d3b"] as const;

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const UTF8 = new TextEncoder();

/** The 32-bit FNV-1a hash of the text's UTF-8 bytes. */
export function fnv1a(text: string): number {
  let hash = FNV_OFFSET;
  for (const byte of UTF8.encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** A member's colour: the same on every score; two members may share one, their name tags tell them apart. */
export function colorOf(accountId: string): string {
  return PRESENCE_PALETTE[fnv1a(accountId) % PRESENCE_PALETTE.length]!;
}

/** Who a connection belongs to, as the server knows it. */
export interface PresenceIdentity {
  accountId: string;
  displayName: string;
}

/**
 * The state a member's tab sent, rebuilt: the identity the connection's, the mode, the cursor and
 * the selection kept only when they have their shape (null otherwise), anything else dropped. A
 * connection that cannot change the score (a Viewer's, or any on a read-only document) is in "read".
 */
export function presenceOf(sent: unknown, { accountId, displayName }: PresenceIdentity, readOnly: boolean): PresenceState {
  const fields = typeof sent === "object" && sent !== null ? (sent as Record<string, unknown>) : {};
  const mode = presenceMode.safeParse(fields.mode);
  const cursor = presenceCursor.safeParse(fields.cursor);
  const selection = presenceSelection.safeParse(fields.selection);
  return {
    accountId,
    displayName,
    color: colorOf(accountId),
    mode: readOnly || !mode.success ? "read" : mode.data,
    cursor: cursor.success ? cursor.data : null,
    selection: selection.success ? selection.data : null,
  };
}

/**
 * The awareness clients a connection may speak for: its own, the one it announced first, and no
 * other. A provider speaks for one client, its document's; a client another connection of the
 * document speaks for is not this one's to change or to remove. `own` are the clients the
 * connection announced so far, `others` those of the document's other connections, `sent` those
 * an update names, in its order.
 */
export function clientsAllowed(own: ReadonlySet<number>, others: ReadonlySet<number>, sent: Iterable<number>): Set<number> {
  const allowed = new Set<number>();
  let claimed = own.size > 0;
  for (const client of sent) {
    if (own.has(client)) {
      allowed.add(client);
    } else if (!claimed && !others.has(client)) {
      allowed.add(client);
      claimed = true;
    }
  }
  return allowed;
}

/** A connection whose awareness update the server is about to apply. */
export interface AwarenessSource {
  /**
   * Who it belongs to, as the server knows it now: a member, with their display name of now; a
   * guest; or undefined when the server does not know (never the case of a connection let in).
   */
  who: ({ kind: "member" } & PresenceIdentity) | { kind: "guest" } | undefined;
  /** It cannot change the score: a Viewer's, or any on a frozen document. */
  readOnly: boolean;
  /** The clients it announced so far, and those of the document's other connections. */
  own: ReadonlySet<number>;
  others: ReadonlySet<number>;
}

/**
 * The awareness update as the server applies it, `states` and `removedClients` changed in place
 * (Hocuspocus's `beforeHandleAwareness`): from a member, only their own client, its state rebuilt
 * (`presenceOf`); from a guest, or from a connection the server cannot tell, nothing at all
 * (docs/spec/collab.md, section 5): a guest is not in the presence, and what is not known to be a
 * member's is not let in either.
 */
export function screenAwareness({ who, readOnly, own, others }: AwarenessSource, states: Map<number, unknown>, removedClients: Set<number>): void {
  if (who?.kind !== "member") {
    states.clear();
    removedClients.clear();
    return;
  }
  const allowed = clientsAllowed(own, others, [...states.keys(), ...removedClients]);
  for (const client of removedClients) if (!allowed.has(client)) removedClients.delete(client);
  for (const [client, state] of states) {
    if (allowed.has(client)) states.set(client, presenceOf(state, who, readOnly));
    else states.delete(client);
  }
}
