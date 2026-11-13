import { expect, test } from "vitest";

import { decideView, type Role, type View } from "../src/index";

// Every combination, written out from the table of docs/spec/views.md, section 1. A guest has no
// role; the rows of a guest with one, and of a member without one, check that neither can edit.
const table: [isGuest: boolean, role: Role | null, canType: boolean, view: View][] = [
  [true, null, true, "read"],
  [true, null, false, "read"],
  [true, "owner", true, "read"],
  [true, "owner", false, "read"],
  [true, "editor", true, "read"],
  [true, "editor", false, "read"],
  [true, "viewer", true, "read"],
  [true, "viewer", false, "read"],
  [false, "owner", true, "editable"],
  [false, "owner", false, "read"],
  [false, "editor", true, "editable"],
  [false, "editor", false, "read"],
  [false, "viewer", true, "readOnlyEdit"],
  [false, "viewer", false, "read"],
  [false, null, true, "read"],
  [false, null, false, "read"],
];

test.each(table)("guest %s, role %s, can type %s: %s", (isGuest, role, canType, view) => {
  expect(decideView({ role, isGuest, canType })).toBe(view);
});
