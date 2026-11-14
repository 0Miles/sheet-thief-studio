// One member typing on a score: the cursor, the keys and the commands they run, and undo. Each
// key that changes the score is one command, one undo step. Nothing here touches the DOM, the
// renderer or the connection to the server, so any Y.Doc will do.
import {
  barsOf,
  beatPositionOf,
  type Cursor,
  deleteBeat,
  deleteNote,
  deleteSelection,
  extendSelection,
  insertBeat,
  isRestAt,
  LOCAL,
  moveByBar,
  moveByBeat,
  moveByLine,
  moveFromAppendedBeat,
  type OnOffTechnique,
  onOffToggle,
  partKindOf,
  partsOf,
  type Selection,
  type SelectionStep,
  setFret,
  settleCursor,
  settleSelection,
  stepDuration,
  toggleAt,
  toggleOnSelection,
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
  /**
   * What this member selected (docs/spec/commands.md, section 4): extended with Shift, it ends
   * with a move without Shift, Esc, a click, or any command that does not work on it. Null once
   * a beat, bar or part it starts or ends on is gone.
   */
  readonly selection: Selection | null;
  presence(): LocalPresence;
  /** Called with the presence each time the cursor or the selection changes. */
  onPresence(listener: (presence: LocalPresence) => void): () => void;
  /**
   * Handle a key at the cursor. True when it is one of the session's keys: the shell then calls
   * `preventDefault`. Any other key, copy, cut and paste, whose work is done in the events the
   * browser fires for them, and the page's keys (`pageEffectOf`: Space plays) are left alone.
   */
  press(key: Key): boolean;
  /** Put the cursor somewhere else (a click on the page), ending the selection. Never changes the score. */
  moveTo(cursor: Cursor | null): void;
  /**
   * Called the first time a key that would change the score is refused because the session is
   * read-only (the shell says 「檢視者無法修改」), and never again.
   */
  onRefused(listener: () => void): () => void;
  destroy(): void;
}

/**
 * What a key does: the command it runs at a cursor, where that leaves the cursor and the
 * selection, and whether it changes the score.
 */
interface KeyCommand {
  changes: boolean;
  run(at: Cursor): LocalPresence;
}

/** A move or a command that does not work on the selection: the selection ends. */
const move = (run: (at: Cursor) => Cursor): KeyCommand => ({ changes: false, run: (at) => ({ cursor: run(at), selection: null }) });
const change = (run: (at: Cursor) => Cursor | null): KeyCommand => ({ changes: true, run: (at) => ({ cursor: run(at), selection: null }) });

/** The same fields with the same values, or both none: two cursors at one place, two selections of the same. */
function same<T extends object>(a: T | null, b: T | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const keys = Object.keys(a) as (keyof T)[];
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
  let selection: Selection | null = null;
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
    return { cursor, selection };
  }

  /** Put the cursor and the selection there, and tell the presence when either moved. */
  function putAt({ cursor: next, selection: selected }: LocalPresence): void {
    const moved = !same(next, cursor);
    if (!moved && same(selected, selection)) return;
    if (moved) {
      if (next?.at !== "on" || next.beatId !== appended) appended = null;
      cursor = next;
      position = next && beatPositionOf(doc, next);
    }
    selection = selected;
    const told = presence();
    for (const listener of presenceListeners) listener(told);
  }

  /** The cursor on a place that exists, whatever changed the score. */
  const settled = (at: Cursor | null): Cursor | null => at && settleCursor(doc, at, position);
  const settle = (): void => {
    if (running) return;
    // A cursor put on a beat that had not arrived yet: its position is taken now that it is here.
    if (position === null && cursor !== null) position = beatPositionOf(doc, cursor);
    putAt({ cursor: settled(cursor), selection: selection && settleSelection(doc, selection) });
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

  /** → from the cursor: after a beat just made in the append slot, as if it were still the last of its voice. */
  const nextBeat = (at: Cursor): Cursor => (appended !== null && at.beatId === appended ? moveFromAppendedBeat(doc, at) : moveByBeat(doc, at, 1));

  /** A move with Shift held: the selection is extended to where the cursor goes (docs/spec/commands.md, section 4). */
  const extend = (step: SelectionStep, run: (at: Cursor) => Cursor): KeyCommand => ({
    changes: false,
    run: (at) => {
      const next = run(at);
      return { cursor: next, selection: extendSelection(selection, at, next, step) };
    },
  });

  /** A command that works on the selection: it stays as long as what it holds is there. */
  const onSelection = (selected: Selection, run: (at: Cursor) => Cursor): KeyCommand => ({
    changes: true,
    run: (at) => ({ cursor: run(at), selection: settleSelection(doc, selected) }),
  });

  /** A command that works on the selection when there is one (which then stays), else at the cursor. */
  const selectionOrCursor = (onSelected: (selected: Selection, at: Cursor) => Cursor, atCursor: (at: Cursor) => Cursor): KeyCommand => {
    const selected = selection;
    return selected === null ? change(atCursor) : onSelection(selected, (at) => onSelected(selected, at));
  };

  /**
   * A technique key (docs/spec/commands.md, 5.4): on every note of the selection, which stays;
   * else on the note of the cursor's string, where dead may make a note, and a beat for it in
   * the append slot. Fretted parts only, until the keys of drums and staves name their notes.
   */
  function toggleTechnique(technique: OnOffTechnique): KeyCommand {
    const toggle = onOffToggle(technique);
    return selectionOrCursor(
      (selected, at) => toggleOnSelection(doc, selected, at, toggle),
      (at) => markAppended(at, (here) => toggleAt(doc, here, `s${here.line}`, toggle)),
    );
  }

  /** What a key runs, at the cursor (docs/spec/keymap.md, sections 2, 3 and 4.1). */
  function commandOf({ effect, value = 0 }: SessionBinding, previous: TypedDigit | null): KeyCommand {
    switch (effect) {
      case "nextBeat":
        return move(nextBeat);
      case "previousBeat":
        return move((at) => moveByBeat(doc, at, -1));
      case "selectNextBeat":
        return extend("beat", nextBeat);
      case "selectPreviousBeat":
        return extend("beat", (at) => moveByBeat(doc, at, -1));
      case "selectNextBar":
        return extend("bar", (at) => moveByBar(doc, at, 1));
      case "selectPreviousBar":
        return extend("bar", (at) => moveByBar(doc, at, -1));
      case "deselect":
        return move((at) => at);
      case "lineDown":
        return move((at) => moveByLine(doc, at, 1));
      case "lineUp":
        return move((at) => moveByLine(doc, at, -1));
      case "insertBeat":
        return change((at) => markAppended(at, (here) => insertBeat(doc, here)));
      case "delete":
        return selectionOrCursor(
          (selected, at) => deleteSelection(doc, selected, at),
          (at) => (isRestAt(doc, at) ? deleteBeat(doc, at) : deleteNote(doc, at)),
        );
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
      default:
        // What is left are the on/off techniques: a new effect without a case of its own fails to type here.
        return toggleTechnique(effect);
    }
  }

  return {
    get cursor() {
      return cursor;
    },
    get selection() {
      return selection;
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
      if (binding === undefined || binding.native || binding.page) return false;
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
      let next: LocalPresence;
      try {
        next = command.run(cursor);
      } finally {
        running = false;
      }
      putAt(next);
      return true;
    },
    moveTo(next) {
      putAt({ cursor: next, selection: null });
    },
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
