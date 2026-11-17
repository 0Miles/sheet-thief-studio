// Which of the three views a member or a guest gets (docs/spec/views.md, section 1).

/** A member's role on a score (CONTEXT.md). */
export type Role = "owner" | "editor" | "viewer";

/**
 * `editable`: the edit view, for typing. `readOnlyEdit`: the same view where nothing changes the
 * score. `read`: the Read view, for looking and listening only.
 */
export type View = "editable" | "readOnlyEdit" | "read";

export interface ViewInput {
  /** Null for a guest. */
  role: Role | null;
  /** Opened through a read-only link without logging in. */
  isGuest: boolean;
  /**
   * The device can be typed on: the shell measures it once, when the page loads (a fine pointer
   * and a window at least 1024 px wide). The browser does not matter.
   */
  canType: boolean;
}

export function decideView({ role, isGuest, canType }: ViewInput): View {
  if (isGuest || !canType) return "read";
  if (role === "owner" || role === "editor") return "editable";
  if (role === "viewer") return "readOnlyEdit";
  // Not a member: nothing to edit with. The server does not open the score to them anyway.
  return "read";
}
