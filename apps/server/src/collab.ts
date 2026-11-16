// Co-editing: Hocuspocus inside the API process, on the WebSocket path /collab (docs/adr/0001,
// docs/spec/collab.md). One Hocuspocus document per score, its name the score id, its Yjs state
// in Postgres. A connection gets in with a collab ticket (ADR 0005), and the server keeps a
// register of its connections to close only the ones an event concerns.
import type { IncomingMessage as HttpRequest } from "node:http";
import type { Duplex } from "node:stream";

import { type CloseEvent, Forbidden, ResetConnection, Unauthorized } from "@hocuspocus/common";
import { type Connection, type ConnectionConfiguration, Hocuspocus, IncomingMessage, MessageType } from "@hocuspocus/server";
import crossws from "crossws/adapters/node";
import type { CollabNotice } from "@studio/contracts";
import { docToJson, fillMissingContent, isNewerSchema, migrateDoc, type Migration, MIGRATIONS, MissingMigration, readScore } from "@studio/score-model";
import type { FastifyInstance } from "fastify";
import { literal } from "sequelize";
import * as Y from "yjs";

import type { CollabTickets, Guest, Member } from "./collabTickets";
import { Score, type VersionReason } from "./db/models";
import { WEBSOCKET_MESSAGE_LIMIT } from "./limits";
import { scoreOfLink } from "./links";
import { liveScore, membership } from "./scores";
import type { Sessions } from "./sessions";
import { createVersion, VERSION_INTERVAL_MS } from "./versions";

export const COLLAB_PATH = "/collab";

/** How long a document stays unchanged before the server fills in what it misses (docs/spec/collab.md, section 4). */
export const FILL_DEBOUNCE_MS = 1000;

/** How long a store waits for more changes, and the longest it waits however many come (docs/spec/collab.md, section 1). */
export const STORE_DEBOUNCE_MS = 2000;
export const STORE_MAX_DEBOUNCE_MS = 10_000;

/** The `updated_at` a store leaves: now, or the one the score had when it is deleted. */
const STORED_AT = literal("CASE WHEN deleted_at IS NULL THEN now() ELSE updated_at END") as unknown as Date;

/** The `socketId` Hocuspocus gives the `onDisconnect` of a direct connection: the server's own, not a member's. */
const SERVER_SOCKET = "server";

/** Why a document is frozen: read-only for every connection, neither migrated, filled in nor stored. */
type FrozenReason = CollabNotice["reason"];

/**
 * Who a connection belongs to: what `onAuthenticate` read from its ticket and the database. A
 * member's role is the one the database gave when the connection was let in.
 */
export type CollabContext = Member | Guest;

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
   * change reaches the members who have it open and is stored before this resolves. Rejects,
   * changing nothing, when the document is frozen (docs/spec/schema.md, sections 9 and 10).
   */
  change(scoreId: string, transaction: (doc: Y.Doc) => void): Promise<void>;
  /**
   * Close the connections that match, and only those (never `closeConnections(documentName)`,
   * which closes everyone's). Their providers reconnect, each with a new ticket of its own. A
   * connection that matches while its document is still loading has its socket closed at once,
   * before it is sent the document. Returns how many were closed.
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

/** One WebSocket: the scores it opened as a guest, whose presence it is never sent, and whether it has closed. */
interface Socket {
  websocket: WebSocket;
  guestOf: Set<string>;
  closed: boolean;
}

/**
 * A connection let in whose document is loading, not in the register yet (it gets there in the
 * `connected` hook): the event that closed it meanwhile, if one did.
 */
interface Loading {
  holder: Holder;
  socket: Socket;
  closeWith: CloseEvent | null;
}

/** Whether the connection is one of those to close: a field given that a member or a guest does not have never matches. */
function matches(holder: Holder, which: ConnectionsToClose): boolean {
  if (which.scoreId !== undefined && holder.scoreId !== which.scoreId) return false;
  if (holder.kind === "guest") return which.accountId === undefined && which.sessionId === undefined && (which.linkToken === undefined || holder.linkToken === which.linkToken);
  return (
    which.linkToken === undefined &&
    (which.accountId === undefined || holder.accountId === which.accountId) &&
    (which.sessionId === undefined || holder.sessionId === which.sessionId)
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
function withoutGuestPresence(socket: Socket): WebSocket {
  const send = (message: Uint8Array) => {
    if (!isAwarenessOf(message, socket.guestOf)) socket.websocket.send(message);
  };
  return new Proxy(socket.websocket, {
    get(target, key) {
      if (key === "send") return send;
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export interface CollabDependencies {
  tickets: CollabTickets;
  sessions: Sessions;
  /** The steps of the schema; the published ones unless a test registers its own. */
  migrations?: readonly Migration[] | undefined;
}

export function attachCollab(app: FastifyInstance, { tickets, sessions, migrations = MIGRATIONS }: CollabDependencies): Collab {
  const register = new Map<Connection<CollabContext>, Holder>();
  // By the connection configuration Hocuspocus hands both `onAuthenticate` and `connected`: the
  // same object for one connection.
  const loading = new Map<ConnectionConfiguration, Loading>();
  // By the upgrade request each socket was opened with, which the hooks are handed too.
  const socketByRequest = new WeakMap<object, Socket>();
  // The documents in memory this server must not change, by score id: written by a newer schema,
  // or by an older one with a migration step missing (docs/spec/schema.md, sections 9 and 10).
  const frozen = new Map<string, FrozenReason>();
  // The documents changed less than FILL_DEBOUNCE_MS ago, each with the timer that fills it in.
  const fills = new Map<string, NodeJS.Timeout>();

  // The documents in memory, each with the timer that makes a version of it every 10 minutes.
  const versionTimers = new Map<string, NodeJS.Timeout>();
  // The versions being made now: the app waits for them before it closes.
  const versioning = new Set<Promise<void>>();
  // Set as the app closes: from then on the versions are the ones `preClose` makes.
  let closing = false;

  function stopVersions(scoreId: string): void {
    clearInterval(versionTimers.get(scoreId));
    versionTimers.delete(scoreId);
  }

  /**
   * Make a version of the document as it is now, unless the score's latest version is the same
   * (docs/spec/collab.md, 8.3). The content is read once the score's row is locked
   * (`createVersion`): what the document is then, a version made meanwhile compared. Never
   * rejects: a version that could not be made is logged, and the next one is made of whatever the
   * score is then.
   * None of a frozen document, which this server cannot read for sure, nor of one that did not load.
   */
  function makeVersion(document: Y.Doc & { name: string; isLoading: boolean }, reason: VersionReason): Promise<void> {
    const scoreId = document.name;
    if (document.isLoading || frozen.has(scoreId)) return Promise.resolve();
    const making = Promise.resolve()
      .then(() => createVersion(scoreId, () => docToJson(document), reason))
      .then(
        () => undefined,
        (error: unknown) => app.log.error({ scoreId, reason, error }, "making a version of a score failed"),
      )
      .finally(() => versioning.delete(making));
    versioning.add(making);
    return making;
  }

  function cancelFill(scoreId: string): void {
    clearTimeout(fills.get(scoreId));
    fills.delete(scoreId);
  }

  /**
   * Write the document's row. The document is only read: a change made while storing would be
   * stored again. The title and the artist are read as every reader reads them
   * (docs/spec/schema.md, section 11): whatever a member wrote there, this does not throw. The
   * whole state every time, never increments (docs/spec/collab.md, section 1). Only updates:
   * storing never makes a score. `updated_at` is set here, to the clock of the database, unless
   * the score is deleted: what its members typed just before the deletion is stored as their
   * connections are closed, and a deletion is no change of the score (docs/spec/accounts.md, section 8).
   */
  async function store(scoreId: string, document: Y.Doc): Promise<void> {
    const { title, artist, schemaVersion } = readScore(document).score;
    const [count] = await Score.update(
      { docState: Buffer.from(Y.encodeStateAsUpdate(document)), title, artist: artist ?? null, schemaVersion, updatedAt: STORED_AT },
      // `silent`: `updated_at` is the one written above, not the one Sequelize would write.
      { where: { id: scoreId }, silent: true },
    );
    if (count === 0) throw new Error(`no score ${scoreId} to store`);
  }

  /**
   * As a participant: what the fill adds reaches every member and is stored like any change. The
   * change it makes comes back through `onChange` once; by then nothing is missing, and
   * `fillMissingContent` opens no transaction.
   */
  function fill(scoreId: string): void {
    fills.delete(scoreId);
    const document = hocuspocus.documents.get(scoreId);
    if (document === undefined || document.isLoading || frozen.has(scoreId)) return;
    try {
      fillMissingContent(document);
    } catch (error) {
      app.log.error({ scoreId, error }, "filling in the missing content failed");
    }
  }

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

  /**
   * Check that the ticket's holder may still open the score, as the database says now and not as
   * it said when the ticket was given, and give a member the role they have now; `Forbidden` when
   * they may no longer open it.
   */
  async function confirm(holder: Holder): Promise<void> {
    if (holder.kind === "guest") {
      if ((await scoreOfLink(holder.linkToken))?.id !== holder.scoreId) throw Forbidden;
      return;
    }
    const member = await membership(holder.scoreId, holder.accountId);
    if (member === null || !(await sessions.isActive(holder.sessionId))) throw Forbidden;
    holder.role = member.role;
  }

  const hocuspocus = new Hocuspocus<CollabContext>({
    quiet: true,
    // docs/spec/collab.md, section 1. The last connection leaving stores at once.
    debounce: STORE_DEBOUNCE_MS,
    maxDebounce: STORE_MAX_DEBOUNCE_MS,
    async onAuthenticate({ token, documentName, connectionConfig, request }): Promise<CollabContext> {
      const ticket = await tickets.redeem(token);
      // Refused with a code and a reason only: an error with a message would be logged as a fault.
      if (ticket === null || ticket.scoreId !== documentName) throw Forbidden;
      // A socket that closed while the ticket was redeemed would never take the entry below out.
      const socket = socketByRequest.get(request);
      if (socket === undefined || socket.closed) throw Forbidden;
      const holder: Holder = { ...ticket, scoreId: documentName };
      // Closable from here on, before the checks: an event that comes after a check has read
      // the database still finds the connection.
      const entry: Loading = { holder, socket, closeWith: null };
      loading.set(connectionConfig, entry);
      try {
        // The rights now, not those of the ticket: they may have changed in the last 60 seconds.
        // No member, no link, no score (or a deleted one): refused before any document is made.
        await confirm(holder);
      } catch (error) {
        loading.delete(connectionConfig);
        throw error;
      }
      // Hocuspocus drops the changes a read-only connection sends.
      connectionConfig.readOnly = holder.kind === "guest" || holder.role === "viewer";
      // Before the connection is made: it is sent the current awareness as it is made.
      if (holder.kind === "guest") socket.guestOf.add(documentName);
      return holder;
    },
    async connected({ connection, connectionConfig }) {
      const entry = loading.get(connectionConfig);
      loading.delete(connectionConfig);
      if (entry === undefined || entry.closeWith !== null) {
        // Its socket closed while the document was loading: by itself, or because an event
        // concerned it (a session that ended, a member removed, a link revoked).
        close(connection, entry?.closeWith ?? ResetConnection);
        return;
      }
      register.set(connection, entry.holder);
      connection.onClose(() => register.delete(connection));
      // Told why what it sends is dropped, whatever its role (docs/spec/collab.md, section 2.1).
      const reason = frozen.get(connection.document.name);
      if (reason !== undefined) connection.sendStateless(JSON.stringify({ type: "readOnly", reason } satisfies CollabNotice));
    },
    async beforeHandleMessage({ connection, documentName }) {
      // Every connection of a frozen document is read-only, an Owner's and an Editor's too.
      // Here and not in `onAuthenticate`: the first connections are let in before the document
      // is loaded, and each message, the ones queued meanwhile too, passes here before it is applied.
      if (frozen.has(documentName)) connection.readOnly = true;
    },
    async beforeHandleAwareness({ context, states, removedClients }) {
      // A guest is not in the presence (docs/spec/collab.md, section 5): nothing it says about
      // itself or anyone else is applied.
      if (context?.kind !== "guest") return;
      states.clear();
      removedClients.clear();
    },
    async onLoadDocument({ documentName, document }) {
      // Authentication has found the score; a direct connection only ever opens one that exists.
      const score = await liveScore(documentName);
      if (score === null) throw new Error(`no score ${documentName} to load`);
      frozen.delete(documentName);
      // Migrating and filling in happen here and never while storing (a change made there would
      // be stored again). The migration runs on a copy: a step that fails half-way leaves the
      // members the document as it was stored.
      const migrated = new Y.Doc();
      Y.applyUpdate(migrated, score.docState);
      let changed = false;
      if (isNewerSchema(migrated)) {
        frozen.set(documentName, "newerSchema");
        app.log.warn({ scoreId: documentName }, "a score of a newer schema than this server: opened read-only");
      } else {
        try {
          changed = migrateDoc(migrated, migrations);
        } catch (error) {
          if (error instanceof MissingMigration) {
            frozen.set(documentName, "missingMigration");
            app.log.error({ scoreId: documentName, error }, "a score with no migration step to the current schema: opened read-only");
          } else {
            frozen.set(documentName, "migrationFailed");
            app.log.error({ scoreId: documentName, error }, "a migration step failed on a score: opened read-only, as it was stored");
          }
        }
      }
      Y.applyUpdate(document, frozen.has(documentName) || !changed ? score.docState : Y.encodeStateAsUpdate(migrated));
      migrated.destroy();
      if (frozen.has(documentName)) return;
      // What the last members left missing, when they all left before the debounced fill ran.
      const filled = () => {
        changed = true;
      };
      document.on("update", filled);
      try {
        fillMissingContent(document);
      } catch (error) {
        // The score still opens; the fill is tried again after the next change.
        app.log.error({ scoreId: documentName, error }, "filling in the missing content failed");
      } finally {
        document.off("update", filled);
      }
      // Hocuspocus listens to the document's changes only once it is loaded, and unloads one
      // nobody changed without storing it. What the load changed is stored now: done again at
      // the next load, it would be other operations, and a member who still holds these (a tab
      // that reconnects) would bring them back beside the new ones, one content container
      // hiding the other and the notes written in it.
      if (!changed) return;
      try {
        await store(documentName, document);
      } catch (error) {
        // The score still opens; it is stored with the next change.
        app.log.error({ scoreId: documentName, error }, "storing what loading changed in a score failed");
      }
    },
    async onChange({ documentName }) {
      if (frozen.has(documentName)) return;
      cancelFill(documentName);
      fills.set(
        documentName,
        setTimeout(() => fill(documentName), FILL_DEBOUNCE_MS),
      );
    },
    async afterLoadDocument({ documentName }) {
      // While the document is in memory; a tick that finds the content of the latest version makes none.
      stopVersions(documentName);
      versionTimers.set(
        documentName,
        setInterval(() => {
          const document = hocuspocus.documents.get(documentName);
          if (document !== undefined && !closing) void makeVersion(document, "interval");
        }, VERSION_INTERVAL_MS),
      );
    },
    async onDisconnect({ clientsCount, document, socketId }) {
      // The last connection left (docs/spec/collab.md, 8.3): of the document still in memory,
      // and awaited, so that it is unloaded only once its version is made. Not when the server's
      // own connection ends (`collab.change`): a version is made as the members leave.
      if (clientsCount > 0 || socketId === SERVER_SOCKET || closing) return;
      await makeVersion(document, "last_disconnect");
    },
    async afterUnloadDocument({ documentName }) {
      cancelFill(documentName);
      stopVersions(documentName);
      frozen.delete(documentName);
    },
    async onStoreDocument({ documentName, document }) {
      // Nothing of a frozen document is ours to write, its row's `updated_at` included.
      if (frozen.has(documentName)) return;
      await store(documentName, document);
    },
  });

  const collab: Collab = {
    async change(scoreId, transaction) {
      const direct = await hocuspocus.openDirectConnection(scoreId);
      try {
        if (frozen.has(scoreId)) throw new Error(`score ${scoreId} is read-only (${frozen.get(scoreId)}): not changed`);
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
      // Not in the register yet: the socket is closed now, before the document is sent on it.
      // Hocuspocus then never makes the connection, or closes it as it makes it.
      for (const entry of loading.values()) {
        if (entry.closeWith !== null || !matches(entry.holder, which)) continue;
        entry.closeWith = event;
        entry.socket.websocket.close(event.code, event.reason);
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
    // A socket that sends a larger message is closed (1009), the message never read whole
    // (docs/spec/security.md, section 5).
    serverOptions: { maxPayload: WEBSOCKET_MESSAGE_LIMIT },
    hooks: {
      open(peer) {
        const socket: Socket = { websocket: peer.websocket as unknown as WebSocket, guestOf: new Set(), closed: false };
        // The same object for the socket's whole life; Hocuspocus hands it to the hooks.
        socketByRequest.set(peer.request, socket);
        clients.set(peer, hocuspocus.handleConnection(withoutGuestPresence(socket), peer.request as Request));
      },
      message(peer, message) {
        clients.get(peer)?.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        clients.get(peer)?.handleClose({ code: event.code ?? 1000, reason: event.reason ?? "" });
        // What it was still loading will not be connected.
        const socket = socketByRequest.get(peer.request);
        if (socket !== undefined) socket.closed = true;
        for (const [config, entry] of loading) if (entry.socket === socket) loading.delete(config);
      },
      error(peer, error) {
        app.log.error({ peer: peer.id, error }, "collab socket error");
      },
    },
  });

  app.server.on("upgrade", (request: HttpRequest, socket: Duplex, head: Buffer) => {
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
  // Shutting down: close every connection before the server waits for them to end, then make a
  // version of every document still open and store it, while the database is there. `storeDocumentHooks` with
  // `immediately` is awaited and runs after a store already under way; `flushPendingStores()`
  // would only start the debounced stores, without a promise to wait for. The payload is the one
  // Hocuspocus builds for a store that no connection made.
  app.addHook("preClose", async () => {
    for (const scoreId of [...fills.keys()]) cancelFill(scoreId);
    for (const scoreId of [...versionTimers.keys()]) stopVersions(scoreId);
    // The connections closed here leave no time to their `onDisconnect`: the versions of the
    // documents they leave are made here, and the ones under way end, while the database is there.
    closing = true;
    collab.closeConnections({}, ResetConnection);
    await Promise.all([...hocuspocus.documents.values()].map((document) => makeVersion(document, "last_disconnect")));
    await Promise.all(versioning);
    await Promise.all(
      [...hocuspocus.documents.values()].map((document) =>
        hocuspocus.storeDocumentHooks(document, { clientsCount: 0, document, documentName: document.name, instance: hocuspocus, lastContext: {}, lastTransactionOrigin: null }, true),
      ),
    );
  });
  app.decorate("collab", collab);
  return collab;
}
