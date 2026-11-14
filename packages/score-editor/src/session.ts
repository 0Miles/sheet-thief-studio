// One member typing on a score: the cursor, the keys and the commands they run, and undo. Each
// key that changes the score is one command, one undo step. Nothing here touches the DOM, the
// renderer or the connection to the server, so any Y.Doc will do.
import {
  barsOf,
  beatPositionOf,
  type Cursor,
  deleteBeat,
  deleteNote,
  insertBeat,
  isRestAt,
  LOCAL,
  moveByBeat,
  moveByLine,
  moveFromAppendedBeat,
  partKindOf,
  partsOf,
  type Selection,
  setFret,
  settleCursor,
  stepDuration,
} from "@studio/score-model";
import * as Y from "yjs";

import type { SessionBinding } from "./bindings";
import { type Key, type KeyPlatform, matchKey } from "./keys";

/** Two digits typed within this many milliseconds make one two-digit fret. */
export const TWO_DIGIT_WINDOW = 600;

/** The highest fret that can be typed. */
const MAX_FRET = 36;

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
  /** Whose keys the member types with: the shell tells it once, with `detectKeyPlatform`. */
  platform: KeyPlatform;
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
   * `preventDefault`. Any other key, and copy, cut and paste, whose work is done in the events
   * the browser fires for them, are left alone.
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

export function createEditorSession(doc: Y.Doc, { platform, cursor: start = null, readOnly = false, now = () => Date.now() }: EditorSessionOptions): EditorSession {
  // Only what this member did is undone (docs/adr/0001); one command, one step.
  const undo = new Y.UndoManager([barsOf(doc), partsOf(doc)], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
  let cursor = start;
  let lastDigit: TypedDigit | null = null;
  /**
   * The beat this member just made in the append slot, while the cursor is still on it: the next
   * → takes it as the new anchor (docs/spec/commands.md, 5.1).
   */
  let appended: string | null = null;
  /**
   * Where the cursor's beat stands, taken each time the cursor moves, or once its beat arrives:
   * a removed beat's place.
   */
  let position = start && beatPositionOf(doc, start);
  /** While a key's command runs: the cursor moves once, where the command puts it. */
  let running = false;
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
    position = next && beatPositionOf(doc, next);
    const told = presence();
    for (const listener of presenceListeners) listener(told);
  }

  /** The cursor on a place that exists, whatever changed the score. */
  const settled = (at: Cursor | null): Cursor | null => at && settleCursor(doc, at, position);
  const settle = (): void => {
    if (running) return;
    // A cursor put on a beat that had not arrived yet: its position is taken now that it is here.
    if (position === null && cursor !== null) position = beatPositionOf(doc, cursor);
    moveTo(settled(cursor));
  };
  doc.on("afterTransaction", settle);

  /**
   * Run a command that may make a beat in the append slot (a note typed there, or Insert): when
   * it does, the next → takes that beat as the new anchor (docs/spec/commands.md, 5.1).
   */
  function markAppended(at: Cursor, make: (at: Cursor) => Cursor): Cursor {
    const next = make(at);
    if (at.at === "after" && next.at === "on" && next.beatId !== at.beatId) appended = next.beatId;
    return next;
  }

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
    const next = markAppended(at, (here) => setFret(doc, here, digit));
    lastDigit = { digit, at: now(), cursor: next };
    return next;
  }

  /** What a key runs, at the cursor (docs/spec/keymap.md, sections 2 and 4.1). */
  function commandOf({ effect, value = 0 }: SessionBinding, previous: TypedDigit | null): KeyCommand {
    switch (effect) {
      case "nextBeat":
        return move((at) => (appended !== null && at.beatId === appended ? moveFromAppendedBeat(doc, at) : moveByBeat(doc, at, 1)));
      case "previousBeat":
        return move((at) => moveByBeat(doc, at, -1));
      case "lineDown":
        return move((at) => moveByLine(doc, at, 1));
      case "lineUp":
        return move((at) => moveByLine(doc, at, -1));
      case "insertBeat":
        return change((at) => markAppended(at, (here) => insertBeat(doc, here)));
      case "delete":
        return change((at) => (isRestAt(doc, at) ? deleteBeat(doc, at) : deleteNote(doc, at)));
      case "shorter":
        return change((at) => stepDuration(doc, at, 1));
      case "longer":
        return change((at) => stepDuration(doc, at, -1));
      case "undo":
      case "redo":
        return change((at) => {
          if (effect === "redo") undo.redo();
          else undo.undo();
          return settled(at);
        });
      case "fret":
        return change((at) => typeDigit(value, at, previous));
    }
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
      // A part whose kind cannot be read has no note keys (docs/spec/schema.md, section 11).
      const binding = matchKey(key, platform, partKindOf(partsOf(doc).get(cursor.partId)));
      if (binding === undefined || binding.native) return false;
      // Held down, only moves, + and - run again; the repeats of the others are still not the browser's.
      if (key.repeat === true && !binding.repeat) return true;
      // A digit waits for a second one; any other key that runs something ends the wait.
      const previous = lastDigit;
      lastDigit = null;
      const command = commandOf(binding, previous);
      if (command.changes && readOnly) {
        if (!refused) {
          refused = true;
          for (const listener of refusedListeners) listener();
        }
        return true;
      }
      running = true;
      let next: Cursor | null;
      try {
        next = command.run(cursor);
      } finally {
        running = false;
      }
      moveTo(next);
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
