// One member typing on a score: the cursor, the keys and the commands they run, and undo. Each
// key that changes the score is one command, one undo step. Nothing here touches the DOM, the
// renderer or the connection to the server, so any Y.Doc will do.
import {
  barsOf,
  type Cursor,
  deleteBeat,
  deleteNote,
  insertBeat,
  isRestAt,
  LOCAL,
  moveByBeat,
  moveByLine,
  moveFromAppendedBeat,
  type PartKind,
  partKindOf,
  partsOf,
  type Selection,
  setFret,
  settleCursor,
  stepDuration,
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
}

/**
 * What this member shows the others (docs/spec/views.md, section 8). The shell writes it to the
 * awareness, next to the fields the server fills in.
 */
export interface LocalPresence {
  cursor: Cursor | null;
  /** Until selecting comes (#21), the session has none. */
  selection: Selection | null;
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
  /**
   * Where this member is typing. When a change (another member's, or an undo) removes its beat,
   * it moves to the nearest place still there; null once its part or bar is gone.
   */
  readonly cursor: Cursor | null;
  readonly selection: Selection | null;
  presence(): LocalPresence;
  /** Called with the presence each time the cursor or the selection changes. */
  onPresence(listener: (presence: LocalPresence) => void): () => void;
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

/** What a key does: the command it runs at a cursor, and whether that changes the score. */
interface KeyCommand {
  changes: boolean;
  run(at: Cursor): Cursor | null;
}

const move = (run: (at: Cursor) => Cursor): KeyCommand => ({ changes: false, run });
const change = (run: (at: Cursor) => Cursor | null): KeyCommand => ({ changes: true, run });

function samePlace(a: Cursor | null, b: Cursor | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const keys = Object.keys(a) as (keyof Cursor)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

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
  /**
   * The beat this member just made in the append slot, while the cursor is still on it: the next
   * → takes it as the new anchor (docs/spec/commands.md, 5.1).
   */
  let appended: string | null = null;
  const refusedListeners = new Set<() => void>();
  let refused = false;
  const presenceListeners = new Set<(presence: LocalPresence) => void>();

  function presence(): LocalPresence {
    return { cursor, selection: null };
  }

  function moveTo(next: Cursor | null): void {
    if (samePlace(next, cursor)) return;
    if (next?.at !== "on" || next.beatId !== appended) appended = null;
    cursor = next;
    const told = presence();
    for (const listener of presenceListeners) listener(told);
  }

  // Whatever changed the score, the cursor stays on a place that exists.
  const settle = (): void => moveTo(cursor && settleCursor(doc, cursor));
  doc.on("afterTransaction", settle);

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
    // In the append slot the digit also makes the beat it goes on, and the cursor moves onto it.
    const next = setFret(doc, at, digit);
    lastDigit = { digit, at: now(), cursor: next };
    return next;
  }

  /** Undo and redo. */
  function shortcut(key: Key): KeyCommand | undefined {
    if (key.code !== "KeyZ" && key.code !== "KeyY") return undefined;
    const redo = key.code === "KeyY" || key.shiftKey === true;
    return change(() => {
      if (redo) undo.redo();
      else undo.undo();
      // The undo's transaction has already settled the cursor on what is left.
      return cursor;
    });
  }

  /** The keys that enter notes, which depend on the kind of the part (docs/spec/keymap.md, section 4). */
  const noteKeys: Record<PartKind, (key: Key, previous: TypedDigit | null) => KeyCommand | undefined> = {
    fretted(key, previous) {
      if (/^[0-9]$/.test(key.key)) return change((at) => typeDigit(Number(key.key), at, previous));
      return undefined;
    },
    // Drums and staves get theirs with their milestones (docs/ROADMAP.md, M2 and M3).
    percussion: () => undefined,
    pitched: () => undefined,
  };

  /** The keys of every kind of part. */
  function commonKey(key: Key): KeyCommand | undefined {
    switch (key.key) {
      case "ArrowRight":
        return move((at) => (appended !== null && at.beatId === appended ? moveFromAppendedBeat(doc, at) : moveByBeat(doc, at, 1)));
      case "ArrowLeft":
        return move((at) => moveByBeat(doc, at, -1));
      case "ArrowDown":
        return move((at) => moveByLine(doc, at, 1));
      case "ArrowUp":
        return move((at) => moveByLine(doc, at, -1));
      case "Insert":
        return change((at) => insertBeat(doc, at));
      // The key marked delete on a Mac keyboard sends Backspace (docs/spec/keymap.md, section 2).
      case "Delete":
      case "Backspace":
        return change((at) => (isRestAt(doc, at) ? deleteBeat(doc, at) : deleteNote(doc, at)));
      case "+":
        return change((at) => stepDuration(doc, at, 1));
      case "-":
        return change((at) => stepDuration(doc, at, -1));
      default:
        return undefined;
    }
  }

  function commandFor(key: Key, at: Cursor, previous: TypedDigit | null): KeyCommand | undefined {
    if (key.ctrlKey === true || key.metaKey === true) return shortcut(key);
    // A part whose kind cannot be read has no note keys (docs/spec/schema.md, section 11).
    const kind = partKindOf(partsOf(doc).get(at.partId));
    return (kind === undefined ? undefined : noteKeys[kind](key, previous)) ?? commonKey(key);
  }

  return {
    get cursor() {
      return cursor;
    },
    get selection() {
      return null;
    },
    presence,
    onPresence(listener) {
      presenceListeners.add(listener);
      return () => presenceListeners.delete(listener);
    },
    press(key) {
      if (cursor === null) return false;
      // A digit waits for a second one; any other key ends the wait.
      const previous = lastDigit;
      lastDigit = null;
      const command = commandFor(key, cursor, previous);
      if (command === undefined) return false;
      if (command.changes && readOnly) {
        if (!refused) {
          refused = true;
          for (const listener of refusedListeners) listener();
        }
        return true;
      }
      const before = cursor;
      const next = command.run(cursor);
      moveTo(next);
      // A beat made in the append slot (a note typed there, or Insert).
      if (command.changes && before.at === "after" && next?.at === "on") appended = next.beatId;
      return true;
    },
    moveTo,
    onRefused(listener) {
      refusedListeners.add(listener);
      return () => refusedListeners.delete(listener);
    },
    destroy() {
      doc.off("afterTransaction", settle);
      refusedListeners.clear();
      presenceListeners.clear();
      undo.destroy();
    },
  };
}
