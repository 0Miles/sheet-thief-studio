// Co-editing: Hocuspocus inside the API process, on the WebSocket path /collab (docs/adr/0001,
// docs/spec/collab.md). One Hocuspocus document per score, its name the score id, its Yjs state
// in Postgres. A connection gets in with a collab ticket (ADR 0005), and the server keeps a
// register of its connections to close only the ones an event concerns.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { type CloseEvent, Forbidden, ResetConnection, Unauthorized } from "@hocuspocus/common";
import { type Connection, Hocuspocus } from "@hocuspocus/server";
import crossws from "crossws/adapters/node";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";

import type { CollabTickets } from "./collabTickets";
import { type Role, Score } from "./db/models";
import { liveScore, membership } from "./scores";
import type { Sessions } from "./sessions";

export const COLLAB_PATH = "/collab";

/** Who a connection belongs to: what `onAuthenticate` read from its ticket and the database. */
export interface CollabContext {
  accountId: string;
  sessionId: string;
  role: Role;
}

/** The connections to close: those that match every field given. */
export interface ConnectionsToClose {
  scoreId?: string;
  accountId?: string;
  sessionId?: string;
}

export interface Collab {
  /**
   * Change a score's document as the server, a participant like any other (docs/adr/0001): the
   * change reaches the members who have it open and is stored before this resolves.
   */
  change(scoreId: string, transaction: (doc: Y.Doc) => void): Promise<void>;
  /**
   * Close the connections that match, and only those (never `closeConnections(documentName)`,
   * which closes everyone's). Their providers reconnect, each with a new ticket of its own.
   * Returns how many were closed.
   */
  closeConnections(which: ConnectionsToClose, event: CloseEvent): number;
}

declare module "fastify" {
  interface FastifyInstance {
    collab: Collab;
  }
}

/** Raised by onAuthenticate to refuse a connection: a code and reason, no message to log. */
const REFUSED = Forbidden;

export function attachCollab(app: FastifyInstance, { tickets, sessions }: { tickets: CollabTickets; sessions: Sessions }): Collab {
  const register = new Map<Connection<CollabContext>, CollabContext & { scoreId: string }>();

  const hocuspocus = new Hocuspocus<CollabContext>({
    quiet: true,
    // docs/spec/collab.md, section 1. The last connection leaving stores at once.
    debounce: 2000,
    maxDebounce: 10_000,
    async onAuthenticate({ token, documentName, connectionConfig }): Promise<CollabContext> {
      const ticket = await tickets.redeem(token);
      if (ticket === null || ticket.scoreId !== documentName) throw REFUSED;
      // The role now, not the one of the ticket: it may have changed in the last 60 seconds.
      // No member, no score (or a deleted one): refused before any document is made.
      const member = await membership(documentName, ticket.accountId);
      if (member === null || !(await sessions.isActive(ticket.sessionId))) throw REFUSED;
      // Hocuspocus drops the changes a read-only connection sends.
      connectionConfig.readOnly = member.role === "viewer";
      return { accountId: ticket.accountId, sessionId: ticket.sessionId, role: member.role };
    },
    async connected({ connection, documentName, context }) {
      register.set(connection, { ...context, scoreId: documentName });
      connection.onClose(() => register.delete(connection));
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
      for (const [connection, owner] of register) {
        if (which.scoreId !== undefined && owner.scoreId !== which.scoreId) continue;
        if (which.accountId !== undefined && owner.accountId !== which.accountId) continue;
        if (which.sessionId !== undefined && owner.sessionId !== which.sessionId) continue;
        // Out of the document first, so that nothing more it sends is applied; then the socket,
        // so that the provider reconnects and has to show a new ticket.
        connection.close(event);
        connection.webSocket.close(event.code, event.reason);
        closed += 1;
      }
      return closed;
    },
  };

  // A session that ends takes its connections along: one session's when it logs out, all the
  // account's otherwise (docs/spec/accounts.md, section 9).
  sessions.onEnd(({ accountId, sessionId }) => {
    collab.closeConnections(sessionId === null ? { accountId } : { sessionId }, Unauthorized);
  });

  type ClientConnection = ReturnType<Hocuspocus["handleConnection"]>;
  const clients = new WeakMap<object, ClientConnection>();
  const sockets = crossws({
    hooks: {
      open(peer) {
        clients.set(peer, hocuspocus.handleConnection(peer.websocket as unknown as WebSocket, peer.request as Request));
      },
      message(peer, message) {
        clients.get(peer)?.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        clients.get(peer)?.handleClose({ code: event.code ?? 1000, reason: event.reason ?? "" });
      },
      error(peer, error) {
        app.log.error({ peer: peer.id, error }, "collab socket error");
      },
    },
  });

  app.server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === COLLAB_PATH || path.startsWith(`${COLLAB_PATH}/`)) {
      sockets.handleUpgrade(request, socket, head).catch((error: unknown) => {
        app.log.error(error);
        socket.destroy();
      });
    } else {
      socket.destroy();
    }
  });
  // Shutting down: close every connection before the server waits for them to end, then store
  // every document still open, while the database is there.
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
