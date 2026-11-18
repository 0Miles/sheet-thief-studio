// The presence of a member on a score: the awareness state each of their tabs shows the others
// (docs/spec/views.md, section 8; docs/spec/collab.md, section 5). The server rebuilds every state
// it is sent from these shapes, its identity fields written from the connection (ADR 0005); the
// web app reads the others' states with them. Nothing else a client puts in its state is passed on.
import type { Cursor, Selection } from "@studio/score-model";
import { z } from "zod";

/** The longest id of a part, a bar or a beat a presence may name: the ids the app makes are 10 characters. */
export const PRESENCE_ID_MAX = 64;

const id = z.string().min(1).max(PRESENCE_ID_MAX);
/** "staff:voice", each a small number. */
const voice = z.string().regex(/^\d{1,2}:\d{1,2}$/);

/** A cursor by its anchors (docs/spec/commands.md, section 2): never a place on the page, never an index. */
export const presenceCursor = z.object({
  partId: id,
  barId: id,
  voice,
  beatId: id.nullable(),
  at: z.enum(["on", "after"]),
  // Strings count from 1, staff positions from −4; whoever draws it keeps it on the part's lines.
  line: z.int().min(-64).max(64),
}) satisfies z.ZodType<Cursor>;

/** A selection (docs/spec/commands.md, section 4). */
export const presenceSelection = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("beats"), partId: id, barId: id, voice, anchorBeatId: id, focusBeatId: id }),
  z.object({ kind: z.literal("bars"), partId: id, anchorBarId: id, focusBarId: id }),
]) satisfies z.ZodType<Selection>;

/** "edit" in the editable view; "read" in the read-only edit view and the Read view. */
export const presenceMode = z.enum(["edit", "read"]);
export type PresenceMode = z.infer<typeof presenceMode>;

/**
 * What a tab tells the others. `accountId`, `displayName` and `color` are the server's: whatever
 * the client wrote there is replaced. A member in the Read view has no cursor.
 */
export const presenceState = z.object({
  accountId: z.string().min(1).max(PRESENCE_ID_MAX),
  displayName: z.string().max(200),
  color: z.string().regex(/^#[0-9a-f]{6}$/),
  mode: presenceMode,
  cursor: presenceCursor.nullable(),
  selection: presenceSelection.nullable(),
});
export type PresenceState = z.infer<typeof presenceState>;

/** What a tab writes into its own state: the rest is the server's. */
export type LocalPresenceState = Pick<PresenceState, "mode" | "cursor" | "selection">;
