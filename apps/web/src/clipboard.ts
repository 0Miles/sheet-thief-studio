// The clipboard of a score or a phrase (docs/spec/phrases.md, section 2): the DOM's copy, cut and
// paste events, never the async Clipboard API, so no permission is asked. Mod+C, Mod+X and Mod+V
// are left to the browser (docs/spec/keymap.md), which fires the events: Chromium and WebKit at the
// score's focus element, Firefox at <body>. So they are heard on the document, and taken only while
// the score has the keyboard (#52); anywhere else (a text field, a dialog) the browser does its own.
import type { EditorSession, PasteOutcome } from "@studio/score-editor";

import { strings } from "./strings";

const text = strings.score.clipboard;

/** What the member is told after a paste; null when there is nothing to tell. */
export function pasteNotice(outcome: PasteOutcome): string | null {
  // Read-only is told by the session's refusal.
  if (outcome === null) return null;
  if (typeof outcome === "string") return text.refused[outcome];
  return outcome.hints.length === 0 ? null : outcome.hints.map((hint) => text.hints[hint]).join(text.joiner);
}

/** The page the clipboard is of: where the score's keyboard is, its session, and how it tells the member. */
export interface ClipboardShell {
  scroller(): Element | undefined;
  /** None on a page that only plays. */
  session(): EditorSession | undefined;
  tell(said: string): void;
}

/** Where the events are heard: the document. */
export type ClipboardTarget = Pick<Document, "activeElement" | "addEventListener" | "removeEventListener">;

/** Hear the clipboard's events for a score; returns how to stop. */
export function listenToClipboard(shell: ClipboardShell, target: ClipboardTarget = document): () => void {
  /** The session, while the score has the keyboard; the event's clipboard. */
  const taken = (event: ClipboardEvent) => {
    const session = shell.session();
    const scroller = shell.scroller();
    const data = event.clipboardData;
    if (session === undefined || scroller === undefined || target.activeElement !== scroller || data === null) return undefined;
    return { session, data };
  };
  /** Copy and cut: what the session gives is written, instead of the page's selected text (of which there is none). */
  const writer = (take: (session: EditorSession) => string | null) => (event: ClipboardEvent) => {
    const found = taken(event);
    if (found === undefined) return;
    const written = take(found.session);
    if (written === null) return;
    found.data.setData("text/plain", written);
    event.preventDefault();
  };
  const onCopy = writer((session) => session.copy());
  const onCut = writer((session) => session.cut());
  const onPaste = (event: ClipboardEvent) => {
    const found = taken(event);
    if (found === undefined) return;
    event.preventDefault();
    const said = pasteNotice(found.session.paste(found.data.getData("text/plain")));
    if (said !== null) shell.tell(said);
  };
  target.addEventListener("copy", onCopy);
  target.addEventListener("cut", onCut);
  target.addEventListener("paste", onPaste);
  return () => {
    target.removeEventListener("copy", onCopy);
    target.removeEventListener("cut", onCut);
    target.removeEventListener("paste", onPaste);
  };
}
