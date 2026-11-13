// One member typing on a score: the cursor, the keys and the commands they run, and undo. Each
// key that changes the score is one command, one undo step. Nothing here touches the DOM, the
// renderer or the connection to the server, so any Y.Doc will do.
import {
  barsOf,
  type Cursor,
  insertBeat,
  LOCAL,
  moveByBeat,
  moveByLine,
  type PartKind,
  partsOf,
  setFret,
  settleCursor,
  stepDuration,
  valueAt,
} from "@studio/score-model";
import * as Y from "yjs";

/** Two digits typed within this many milliseconds make one two-digit fret. */
export const TWO_DIGIT_WINDOW = 600;

/** The highest fret that can be typed. */
const MAX_FRET = 36;

/** The part of a keyboard event the session reads: a `KeyboardEvent` is one. */
export interface Key {
  /**
   * `KeyboardEvent.code`: where the key is on the keyboard, whatever the layout or the input
   * method. Shortcuts with a modifier, and `[` and `]`, are matched on it (docs/spec/keymap.md, 1.1).
   */
  code: string;
  /** `KeyboardEvent.key`: what the key types. */
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

export interface EditorSessionOptions {
  /** Where the cursor starts. */
  cursor?: Cursor | null;
  /**
   * Nothing may change the score: the read-only edit view, for a Viewer. The server drops a
   * Viewer's changes anyway; this keeps the page from showing changes that will not last.
   */
  readOnly?: boolean;
  /** The clock of the two-digit frets, in milliseconds. */
  now?: () => number;
}

export interface EditorSession {
  /** Where this member is typing. */
  readonly cursor: Cursor | null;
  /**
   * Handle a key at the cursor. True when it is one of the session's keys: the shell then calls
   * `preventDefault`. Any other key is left alone.
   */
  press(key: Key): boolean;
  /** Put the cursor somewhere else (a click on the page). Never changes the score. */
  moveTo(cursor: Cursor | null): void;
  /**
   * Called the first time a key that would change the score is refused because the session is
   * read-only (the shell says 「檢視者無法修改」), and never again.
   */
  onRefused(listener: () => void): () => void;
  destroy(): void;
}

/** A key of the session: the command it runs at a cursor, and whether that changes the score. */
interface Action {
  changes: boolean;
  run(at: Cursor): Cursor;
}

const move = (run: (at: Cursor) => Cursor): Action => ({ changes: false, run });
const change = (run: (at: Cursor) => Cursor): Action => ({ changes: true, run });

/** The first digit of what may become a two-digit fret. */
interface TypedDigit {
  digit: number;
  at: number;
  cursor: Cursor;
}

export function createEditorSession(doc: Y.Doc, { cursor: start = null, readOnly = false, now = () => Date.now() }: EditorSessionOptions = {}): EditorSession {
  // Only what this member did is undone (docs/adr/0001); one command, one step.
  const undo = new Y.UndoManager([barsOf(doc), partsOf(doc)], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
  let cursor = start;
  let lastDigit: TypedDigit | null = null;
  const refusedListeners = new Set<() => void>();
  let refused = false;

  function typeDigit(digit: number, at: Cursor, previous: TypedDigit | null): Cursor {
    const second =
      previous !== null &&
      now() - previous.at <= TWO_DIGIT_WINDOW &&
      previous.cursor.beatId === at.beatId &&
      previous.cursor.line === at.line &&
      previous.digit * 10 + digit <= MAX_FRET;
    if (second && previous) {
      // The second digit completes the fret: it joins the undo step of the first.
      undo.captureTimeout = TWO_DIGIT_WINDOW * 2;
      try {
        return setFret(doc, at, previous.digit * 10 + digit);
      } finally {
        undo.captureTimeout = 0;
      }
    }
    let next = at;
    doc.transact(() => {
      // In an empty bar the first digit also makes the beat it goes on.
      if (next.beatId === null) next = insertBeat(doc, next, { value: 4 });
      setFret(doc, next, digit);
    }, LOCAL);
    lastDigit = { digit, at: now(), cursor: next };
    return next;
  }

  /** Undo and redo. */
  function shortcut(key: Key): Action | undefined {
    if (key.code !== "KeyZ" && key.code !== "KeyY") return undefined;
    const redo = key.code === "KeyY" || key.shiftKey === true;
    return change((at) => {
      if (redo) undo.redo();
      else undo.undo();
      return settleCursor(doc, at) ?? at;
    });
  }

  /** The keys that enter notes, which depend on the kind of the part (docs/spec/keymap.md, section 4). */
  const noteKeys: Record<PartKind, (key: Key, previous: TypedDigit | null) => Action | undefined> = {
    fretted(key, previous) {
      if (/^[0-9]$/.test(key.key)) return change((at) => typeDigit(Number(key.key), at, previous));
      if (key.key === "Delete") return change((at) => setFret(doc, at, null));
      return undefined;
    },
    // Drums and staves get theirs with their milestones (docs/ROADMAP.md, M2 and M3).
    percussion: () => undefined,
    pitched: () => undefined,
  };

  /** The keys of every kind of part. */
  function commonKey(key: Key): Action | undefined {
    switch (key.key) {
      case "ArrowRight":
        return move((at) => moveByBeat(doc, at, 1));
      case "ArrowLeft":
        return move((at) => moveByBeat(doc, at, -1));
      case "ArrowDown":
        return move((at) => moveByLine(doc, at, 1));
      case "ArrowUp":
        return move((at) => moveByLine(doc, at, -1));
      case "Insert":
        return change((at) => insertBeat(doc, at, { value: valueAt(doc, at) ?? 4 }));
      case "+":
        return change((at) => stepDuration(doc, at, 1));
      case "-":
        return change((at) => stepDuration(doc, at, -1));
      default:
        return undefined;
    }
  }

  function actionFor(key: Key, at: Cursor, previous: TypedDigit | null): Action | undefined {
    if (key.ctrlKey === true || key.metaKey === true) return shortcut(key);
    const kind = partsOf(doc).get(at.partId)?.get("kind") as PartKind | undefined;
    return (kind && noteKeys[kind](key, previous)) ?? commonKey(key);
  }

  return {
    get cursor() {
      return cursor;
    },
    press(key) {
      if (cursor === null) return false;
      // Any key but a second digit ends the time for one.
      const previous = lastDigit;
      lastDigit = null;
      const action = actionFor(key, cursor, previous);
      if (action === undefined) return false;
      if (action.changes && readOnly) {
        if (!refused) for (const listener of refusedListeners) listener();
        refused = true;
        return true;
      }
      cursor = action.run(cursor);
      return true;
    },
    moveTo(next) {
      cursor = next;
    },
    onRefused(listener) {
      refusedListeners.add(listener);
      return () => refusedListeners.delete(listener);
    },
    destroy() {
      refusedListeners.clear();
      undo.destroy();
    },
  };
}
