// Co-editing: Hocuspocus inside the API process, on the WebSocket path /collab (docs/adr/0001,
// docs/spec/collab.md). One Hocuspocus document per score, its name the score id, its Yjs state
// in Postgres. A connection gets in with a collab ticket (ADR 0005), and the server keeps a
// register of its connections to close only the ones an event concerns.
import type { IncomingMessage as Upgrade } from "node:http";
import type { Duplex } from "node:stream";

import { type CloseEvent, Forbidden, ResetConnection, Unauthorized } from "@hocuspocus/common";
import { type Connection, type ConnectionConfiguration, Hocuspocus, IncomingMessage, MessageType } from "@hocuspocus/server";
import type { Role } from "@studio/contracts";
import crossws from "crossws/adapters/node";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";

import type { CollabTickets } from "./collabTickets";
import { Score } from "./db/models";
import { isLinkOf } from "./links";
import { liveScore, membership } from "./scores";
import type { Sessions } from "./sessions";

export const COLLAB_PATH = "/collab";

/**
 * Who a connection belongs to: what `onAuthenticate` read from its ticket and the database. A
 * member has an account, a session and a role; a guest has the token of the read-only link it
 * came with, and nothing else.
 */
export interface CollabContext {
  accountId: string | null;
  sessionId: string | null;
  linkToken: string | null;
  /** Null for a guest, who is no member. */
  role: Role | null;
}

/** The connections to close: those that match every field given. */
export interface ConnectionsToClose {
  scoreId?: string;
  accountId?: string;
  sessionId?: string;
  linkToken?: string;
}

export interface Collab {
  /**
   * Change a score's document as the server, a participant like any other (docs/adr/0001): the
   * change reaches the members who have it open and is stored before this resolves.
   */
  change(scoreId: string, transaction: (doc: Y.Doc) => void): Promise<void>;
  /**
   * Close the connections that match, and only those (never `closeConnections(documentName)`,
   * which closes everyone's). Their providers reconnect, each with a new ticket of its own. A
   * connection that matches while its document is still loading is closed once it is loaded.
   * Returns how many were closed or will be.
   */
  closeConnections(which: ConnectionsToClose, event: CloseEvent): number;
  /** The ids of the scores whose documents are in memory now. For diagnostics and tests only. */
  loadedScores(): string[];
}

declare module "fastify" {
  interface FastifyInstance {
    collab: Collab;
  }
}

/** A connection of the register: whom it belongs to, and which score it opened. */
type Holder = CollabContext & { scoreId: string };

/** One WebSocket: the scores it opened as a guest, whose presence it is never sent. */
interface Socket {
  guestOf: Set<string>;
}

/**
 * A connection let in whose document is loading, not in the register yet (it gets there in the
 * `connected` hook): the event that closes it once it is there, if one came meanwhile.
 */
interface Loading {
  holder: Holder;
  socket: Socket;
  closeWith: CloseEvent | null;
}

function matches(holder: Holder, which: ConnectionsToClose): boolean {
  return (
    (which.scoreId === undefined || holder.scoreId === which.scoreId) &&
    (which.accountId === undefined || holder.accountId === which.accountId) &&
    (which.sessionId === undefined || holder.sessionId === which.sessionId) &&
    (which.linkToken === undefined || holder.linkToken === which.linkToken)
  );
}

/**
 * Whether the message is awareness about one of these documents. A message starts with the name
 * of its document (followed by `\0` and an id for providers with session awareness), then its type.
 */
function isAwarenessOf(message: Uint8Array, documents: Set<string>): boolean {
  if (documents.size === 0) return false;
  try {
    const incoming = new IncomingMessage(message);
    return documents.has(incoming.readVarString().split("\0")[0]!) && incoming.readVarUint() === MessageType.Awareness;
  } catch {
    // Not a message of the protocol: no awareness either.
    return false;
  }
}

/**
 * The WebSocket as Hocuspocus sees it: the same, except that it is never sent the awareness of a
 * score it opened as a guest (docs/spec/collab.md, section 5). Hocuspocus sends a document's
 * awareness to every connection of it, and its current state to each new one, with no hook to
 * leave one out.
 */
function withoutGuestPresence(websocket: WebSocket, socket: Socket): WebSocket {
  return new Proxy(websocket, {
    get(target, key) {
      if (key === "send") {
        return (message: Uint8Array) => {
          if (!isAwarenessOf(message, socket.guestOf)) target.send(message);
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function attachCollab(app: FastifyInstance, { tickets, sessions }: { tickets: CollabTickets; sessions: Sessions }): Collab {
  const register = new Map<Connection<CollabContext>, Holder>();
  // By the connection configuration Hocuspocus hands both `onAuthenticate` and `connected`: the
  // same object for one connection.
  const loading = new Map<ConnectionConfiguration, Loading>();
  // By the upgrade request each socket was opened with, which the hooks are handed too.
  const sockets = new WeakMap<object, Socket>();

  /**
   * Out of the document first, so that nothing more it sends is applied; then the socket, so that
   * the provider reconnects and has to show a new ticket. Our providers open one document per
   * socket: closing the socket closes only this connection. A client that opened several
   * documents on one socket loses them all, and gets them back the same way.
   */
  function close(connection: Connection<CollabContext>, event: CloseEvent): void {
    connection.close(event);
    connection.webSocket.close(event.code, event.reason);
  }

  /** Whether the ticket's member or guest may open the score now, as the database says (not as it said when the ticket was given). */
  async function stillAllowed(holder: Holder): Promise<{ role: Role } | { role: null } | null> {
    if (holder.linkToken !== null) return (await isLinkOf(holder.scoreId, holder.linkToken)) ? { role: null } : null;
    const member = await membership(holder.scoreId, holder.accountId!);
    return member !== null && (await sessions.isActive(holder.sessionId!)) ? { role: member.role } : null;
  }

  const hocuspocus = new Hocuspocus<CollabContext>({
    quiet: true,
    // docs/spec/collab.md, section 1. The last connection leaving stores at once.
    debounce: 2000,
    maxDebounce: 10_000,
    async onAuthenticate({ token, documentName, connectionConfig, request }): Promise<CollabContext> {
      const ticket = await tickets.redeem(token);
      // Refused with a code and a reason only: an error with a message would be logged as a fault.
      if (ticket === null || ticket.scoreId !== documentName) throw Forbidden;
      const socket = sockets.get(request);
      if (socket === undefined) throw Forbidden;
      const holder: Holder =
        "linkToken" in ticket
          ? { scoreId: documentName, accountId: null, sessionId: null, linkToken: ticket.linkToken, role: null }
          : { scoreId: documentName, accountId: ticket.accountId, sessionId: ticket.sessionId, linkToken: null, role: ticket.role };
      // Closable from here on, before the checks: an event that comes after a check has read
      // the database still finds the connection.
      const entry: Loading = { holder, socket, closeWith: null };
      loading.set(connectionConfig, entry);
      try {
        // The rights now, not those of the ticket: they may have changed in the last 60 seconds.
        // No member, no link, no score (or a deleted one): refused before any document is made.
        const allowed = await stillAllowed(holder);
        if (allowed === null) throw Forbidden;
        holder.role = allowed.role;
      } catch (error) {
        loading.delete(connectionConfig);
        throw error;
      }
      // Hocuspocus drops the changes a read-only connection sends.
      connectionConfig.readOnly = holder.role === null || holder.role === "viewer";
      // Before the connection is made: it is sent the current awareness as it is made.
      if (holder.linkToken !== null) socket.guestOf.add(documentName);
      return { accountId: holder.accountId, sessionId: holder.sessionId, linkToken: holder.linkToken, role: holder.role };
    },
    async connected({ connection, connectionConfig }) {
      const entry = loading.get(connectionConfig);
      loading.delete(connectionConfig);
      if (entry === undefined) {
        // Its socket closed while the document was loading.
        close(connection, ResetConnection);
        return;
      }
      register.set(connection, entry.holder);
      connection.onClose(() => register.delete(connection));
      // An event that concerned it came while the document was loading: a session that ended,
      // a member removed, a link revoked.
      if (entry.closeWith !== null) close(connection, entry.closeWith);
    },
    async beforeHandleAwareness({ context, states, removedClients }) {
      // A guest is not in the presence (docs/spec/collab.md, section 5): nothing it says about
      // itself or anyone else is applied.
      if (context?.linkToken == null) return;
      states.clear();
      removedClients.clear();
    },
    async onLoadDocument({ documentName, document }) {
      // Authentication has found the score; a direct connection only ever opens one that exists.
      const score = await liveScore(documentName);
      if (score === null) throw new Error(`no score ${documentName} to load`);
      Y.applyUpdate(document, score.docState);
    },
    async onStoreDocument({ documentName, document }) {
      // The whole state every time, never increments (docs/spec/collab.md, section 1). Only
      // updates: storing never makes a score.
      const [count] = await Score.update({ docState: Buffer.from(Y.encodeStateAsUpdate(document)) }, { where: { id: documentName } });
      if (count === 0) throw new Error(`no score ${documentName} to store`);
    },
  });

  const collab: Collab = {
    async change(scoreId, transaction) {
      const direct = await hocuspocus.openDirectConnection(scoreId);
      try {
        await direct.transact(transaction);
      } finally {
        await direct.disconnect();
      }
    },
    closeConnections(which, event) {
      let closed = 0;
      for (const [connection, holder] of register) {
        if (!matches(holder, which)) continue;
        close(connection, event);
        closed += 1;
      }
      for (const entry of loading.values()) {
        if (entry.closeWith !== null || !matches(entry.holder, which)) continue;
        entry.closeWith = event;
        closed += 1;
      }
      return closed;
    },
    loadedScores() {
      return [...hocuspocus.documents.keys()];
    },
  };

  // A session that ends takes its connections along: one session's when it logs out, all the
  // account's otherwise (docs/spec/accounts.md, section 9).
  sessions.onEnd(({ accountId, sessionId }) => {
    collab.closeConnections(sessionId === null ? { accountId } : { sessionId }, Unauthorized);
  });

  type ClientConnection = ReturnType<Hocuspocus["handleConnection"]>;
  const clients = new WeakMap<object, ClientConnection>();
  const server = crossws({
    hooks: {
      open(peer) {
        const socket: Socket = { guestOf: new Set() };
        // The same object for the socket's whole life; Hocuspocus hands it to the hooks.
        sockets.set(peer.request, socket);
        clients.set(peer, hocuspocus.handleConnection(withoutGuestPresence(peer.websocket as unknown as WebSocket, socket), peer.request as Request));
      },
      message(peer, message) {
        clients.get(peer)?.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        clients.get(peer)?.handleClose({ code: event.code ?? 1000, reason: event.reason ?? "" });
        // What it was still loading will not be connected.
        const socket = sockets.get(peer.request);
        for (const [config, entry] of loading) if (entry.socket === socket) loading.delete(config);
      },
      error(peer, error) {
        app.log.error({ peer: peer.id, error }, "collab socket error");
      },
    },
  });

  app.server.on("upgrade", (request: Upgrade, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === COLLAB_PATH || path.startsWith(`${COLLAB_PATH}/`)) {
      server.handleUpgrade(request, socket, head).catch((error: unknown) => {
        app.log.error(error);
        socket.destroy();
      });
    } else {
      socket.destroy();
    }
  });
  // Shutting down: close every connection before the server waits for them to end, then store
  // every document still open, while the database is there. `storeDocumentHooks` with
  // `immediately` is awaited and runs after a store already under way; `flushPendingStores()`
  // would only start the debounced stores, without a promise to wait for. The payload is the one
  // Hocuspocus builds for a store that no connection made.
  app.addHook("preClose", async () => {
    collab.closeConnections({}, ResetConnection);
    await Promise.all(
      [...hocuspocus.documents.values()].map((document) =>
        hocuspocus.storeDocumentHooks(document, { clientsCount: 0, document, documentName: document.name, instance: hocuspocus, lastContext: {}, lastTransactionOrigin: null }, true),
      ),
    );
  });
  app.decorate("collab", collab);
  return collab;
}
