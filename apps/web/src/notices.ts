// What the collab server tells a tab about its connection, as a stateless message
// (docs/spec/collab.md, sections 2.1 and 9): `readOnly`, the server takes nothing this tab sends
// to the score; `closed`, the server closes the connection for good, and the tab must not
// connect again.
import { type ClosedNotice, collabNotice, type CollabNotice, type ReadOnlyNotice } from "@studio/contracts";

/**
 * Why nobody may change the score here, whatever their role: a newer schema than this page knows
 * (the page reads it from the document, access.ts), or what the server says in its `readOnly`
 * notice. Here, with no DOM: the server's tests open a provider as the web app does.
 */
export type ReadOnlyReason = ReadOnlyNotice["reason"];

/** The server's notice a stateless message carries; null for any other payload. */
export function noticeOf(payload: string): CollabNotice | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const notice = collabNotice.safeParse(parsed);
  return notice.success ? notice.data : null;
}

/** What of a provider this needs: its stateless messages, and its socket to stop. */
export interface NoticedProvider {
  on(event: "stateless", listener: (data: { payload: string }) => void): unknown;
  configuration: { websocketProvider: { disconnect(): void } };
}

/**
 * Stop the provider for good when the server says it closes the connection for good (`closed`,
 * #102): its socket is not to connect again, and `closed` is told why. The provider would
 * otherwise reconnect within a second, with a new ticket, send again what the server refuses, and
 * be closed again, without end. The notice comes before the server closes the socket: the
 * provider's socket then closes without trying again (its `shouldConnect` is false).
 */
export function stopWhenClosed(provider: NoticedProvider, closed: (reason: ClosedNotice["reason"]) => void): void {
  provider.on("stateless", ({ payload }) => {
    const notice = noticeOf(payload);
    if (notice?.type !== "closed") return;
    provider.configuration.websocketProvider.disconnect();
    closed(notice.reason);
  });
}

/**
 * `lock` is told why when the server says it takes nothing this tab sends to the score
 * (`readOnly`, #109): a newer schema, or one it cannot migrate. It says so at every connection,
 * as the connection is made, before or after the document is synced: the order is not given.
 * The connection is kept, the score still read from it.
 */
export function lockWhenReadOnly(provider: Pick<NoticedProvider, "on">, lock: (reason: ReadOnlyReason) => void): void {
  provider.on("stateless", ({ payload }) => {
    const notice = noticeOf(payload);
    if (notice?.type === "readOnly") lock(notice.reason);
  });
}
