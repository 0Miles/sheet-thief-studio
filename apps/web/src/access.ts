// What a member may still do with the score open on the page, and what the page does when that
// changes while it is open (docs/spec/collab.md, section 7; docs/spec/views.md, section 10).
import type { ReadOnlyNotice, Role } from "@studio/contracts";
import type { View } from "@studio/score-editor";
import { isNewerSchema } from "@studio/score-model";
import type * as Y from "yjs";

import { ApiError } from "./api";

/**
 * Why nobody may change the score here, whatever their role: a newer schema than this page knows
 * (the page reads it from the document), or what the server says in its `readOnly` notice (#109).
 */
export type ReadOnlyReason = ReadOnlyNotice["reason"];

/** `newerSchema` when the document was written by a newer schema than this page knows; else null (docs/spec/schema.md, section 9). */
export function readOnlyReasonOf(doc: Y.Doc): ReadOnlyReason | null {
  return isNewerSchema(doc) ? "newerSchema" : null;
}

/** The view the score opens in: the edit view of a score that cannot be written is the read-only one. */
export function openedView(view: View, readOnly: ReadOnlyReason | null): View {
  return readOnly !== null && view === "editable" ? "readOnlyEdit" : view;
}

/** An Owner or an Editor: the role may change the score (whatever the device lets them type). */
export const roleCanType = (role: Role): boolean => role !== "viewer";

/**
 * A reconnection gave the member another role than the page was opened with. `reopen`: they can
 * no longer change the score, or now can. The page's document is dropped, as what was typed since
 * the server stopped taking it would part it from the server's, and the score is opened anew as
 * the new role. `carryOn`: what the page lets them do is unchanged (a transfer makes the Owner an
 * Editor and an Editor the Owner: both keep typing, their document still the server's).
 */
export function afterRoleChange(opened: Role, now: Role): "carryOn" | "reopen" {
  return roleCanType(opened) === roleCanType(now) ? "carryOn" : "reopen";
}

/**
 * Why the page closes the score it has open. `reopen`: its document is dropped and the score
 * opened anew, saying why; read-only from the start when `readOnly` says why (the score was
 * locked here: it stays locked until the page is loaded again). `removed`: the 404 page, saying
 * why. `loggedOut`: /login.
 */
export type Closing = { kind: "reopen"; notice: string; readOnly?: ReadOnlyReason } | { kind: "removed" } | { kind: "loggedOut" };

/**
 * Asking for a new ticket failed for good: `loggedOut` when the session has ended (401),
 * `removed` when the member may no longer open the score, or it was deleted (404). Null for a
 * failure that passes (too many tickets, the server restarting, the network): the provider tries
 * again later.
 */
export function ticketRefusal(error: unknown): "loggedOut" | "removed" | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 401) return "loggedOut";
  if (error.status === 404) return "removed";
  return null;
}
