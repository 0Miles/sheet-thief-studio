// Co-editing: Hocuspocus inside the API process, on the WebSocket path /collab (docs/adr/0001).
// M0 only: every document is open to anyone who can reach the server and lives in memory.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { Hocuspocus } from "@hocuspocus/server";
import crossws from "crossws/adapters/node";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";

export const COLLAB_PATH = "/collab";

type Connection = ReturnType<Hocuspocus["handleConnection"]>;

export function attachCollab(app: FastifyInstance): Hocuspocus {
  // Hocuspocus forgets a document when its last member leaves: keep its state for the next one.
  const states = new Map<string, Uint8Array>();
  const hocuspocus = new Hocuspocus({
    quiet: true,
    async onLoadDocument({ documentName, document }) {
      const state = states.get(documentName);
      if (state) Y.applyUpdate(document, state);
    },
    async onStoreDocument({ documentName, document }) {
      states.set(documentName, Y.encodeStateAsUpdate(document));
    },
  });

  const connections = new WeakMap<object, Connection>();
  const sockets = crossws({
    hooks: {
      open(peer) {
        connections.set(peer, hocuspocus.handleConnection(peer.websocket as unknown as WebSocket, peer.request as Request));
      },
      message(peer, message) {
        connections.get(peer)?.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        connections.get(peer)?.handleClose({ code: event.code ?? 1000, reason: event.reason ?? "" });
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
  app.addHook("onClose", async () => {
    hocuspocus.closeConnections();
  });
  return hocuspocus;
}
