// What a member may still do with the score open on the page, and what the page does when that
// changes (docs/spec/collab.md, section 7; docs/spec/schema.md, section 9).
import { metaOf } from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { afterRoleChange, openedView, readOnlyReasonOf, ticketRefusal } from "../src/access";
import { ApiError } from "../src/api";

/** A document that says it is of this schema version (nothing else of a score in it). */
function docOf(schemaVersion: unknown): Y.Doc {
  const doc = new Y.Doc();
  metaOf(doc).set("schemaVersion", schemaVersion);
  return doc;
}

test("a score of a newer schema than this page knows is read-only; one of the current schema, or with no version that can be read, is not", () => {
  expect(readOnlyReasonOf(docOf(2))).toBe("newerSchema");
  expect(readOnlyReasonOf(docOf(1))).toBeNull();
  expect(readOnlyReasonOf(docOf(0))).toBeNull();
  expect(readOnlyReasonOf(docOf("2"))).toBeNull();
  expect(readOnlyReasonOf(new Y.Doc())).toBeNull();
});

test("a score that cannot be written opens the edit view read-only; the other views stay as they are", () => {
  expect(openedView("editable", "newerSchema")).toBe("readOnlyEdit");
  expect(openedView("readOnlyEdit", "newerSchema")).toBe("readOnlyEdit");
  expect(openedView("read", "newerSchema")).toBe("read");
  // The server's notice of a score it cannot read (#109) locks it the same way.
  expect(openedView("editable", "missingMigration")).toBe("readOnlyEdit");
  expect(openedView("editable", "migrationFailed")).toBe("readOnlyEdit");
  expect(openedView("editable", null)).toBe("editable");
  expect(openedView("readOnlyEdit", null)).toBe("readOnlyEdit");
  expect(openedView("read", null)).toBe("read");
});

test("a role that can no longer type, or now can, opens the score anew; a change between two roles that type does not", () => {
  expect(afterRoleChange("editor", "viewer")).toBe("reopen");
  expect(afterRoleChange("owner", "viewer")).toBe("reopen");
  expect(afterRoleChange("viewer", "editor")).toBe("reopen");
  expect(afterRoleChange("viewer", "owner")).toBe("reopen");
  // A transfer: the old Owner, now an Editor, keeps typing; so does the Editor made Owner.
  expect(afterRoleChange("owner", "editor")).toBe("carryOn");
  expect(afterRoleChange("editor", "owner")).toBe("carryOn");
  expect(afterRoleChange("editor", "editor")).toBe("carryOn");
  expect(afterRoleChange("viewer", "viewer")).toBe("carryOn");
});

test("a ticket refused for the session (401) logs out; for the score (404) leaves it; any other failure passes", () => {
  expect(ticketRefusal(new ApiError(401, "unauthenticated"))).toBe("loggedOut");
  expect(ticketRefusal(new ApiError(404, "not_found"))).toBe("removed");
  expect(ticketRefusal(new ApiError(429, "rate_limited"))).toBeNull();
  expect(ticketRefusal(new ApiError(500, "internal_error"))).toBeNull();
  expect(ticketRefusal(new TypeError("Failed to fetch"))).toBeNull();
});
