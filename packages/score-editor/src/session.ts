// One member typing on a score: the cursor, the keys and the commands they run, and undo. Each
// key that changes the score is one command, one undo step. Nothing here touches the DOM, the
// renderer or the connection to the server, so any Y.Doc will do.
import {
  barsOf,
  type BeatChange,
  beatPositionOf,
  changeBeatAt,
  changeBeatsOnSelection,
  clearNotes,
  type Cursor,
  deleteBeat,
  deleteNote,
  deleteSelection,
  dotCycle,
  durationStep,
  dynamicCycle,
  extendSelection,
  insertBeat,
  isRestAt,
  LOCAL,
  metaOf,
  moveByBar,
  moveByBeat,
  moveByLine,
  moveByStaff,
  moveFromAppendedBeat,
  moveToBarEnd,
  moveToBarStart,
  moveToVoice,
  noteKeyAt,
  type NoteToggle,
  partKindOf,
  partsOf,
  type Selection,
  type SelectionStep,
  setFret,
  setText,
  settleCursor,
  settleSelection,
  slapPopCycle,
  slideInCycle,
  slideOutCycle,
  strokeCycle,
  textAt,
  techniqueToggle,
  tieToggle,
  toggleAt,
  toggleOnSelection,
  tripletToggle,
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

/**
 * What the shell tells the member about a key that did nothing: on a fretted part, Alt+2, as
 * such a part has one voice (「弦樂聲部只有一條聲線」, docs/spec/commands.md, section 3).
 */
export type SessionHint = "oneVoice";

/**
 * Enter on a beat (docs/spec/keymap.md, 6.1): the shell opens a box there for its text, filled
 * with the text it holds (empty for none), and gives what is typed to `setText`.
 */
export interface TextRequest {
  cursor: Cursor;
  text: string;
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
  /** Called each time a key does nothing the member is to be told about. */
  onHint(listener: (hint: SessionHint) => void): () => void;
  /** Called each time Enter asks for the text of the cursor's beat; never in the append slot, nor while read-only. */
  onEditText(listener: (request: TextRequest) => void): () => void;
  /**
   * Save the text of a beat, typed in the box `onEditText` asked for, one command: at `cursor`,
   * the cursor of the request, on whatever beat it names; an empty text takes it away. False,
   * and nothing saved, while read-only (the member is told, as for a key), or for a text longer
   * than `MAX_BEAT_TEXT`. The selection ends, as after any command that does not work on it.
   */
  setText(cursor: Cursor, text: string): boolean;
  destroy(): void;
}

/**
 * What a key does: the command it runs at a cursor, where that leaves the cursor and the
 * selection, and whether it changes the score.
 */
interface KeyCommand {
  changes: boolean;
  /** It changes nothing itself, but asks for a change the member makes next (Enter's text box): refused while read-only all the same. */
  leadsToChange?: true;
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
  // Only what this member did is undone (docs/adr/0001), the title among it. The session, not the
  // clock, tells where an undo step ends: each change of this member's starts one, but the second
  // digit of a fret, which joins the step of the first (`separate`).
  const undo = new Y.UndoManager([barsOf(doc), partsOf(doc), metaOf(doc)], { trackedOrigins: new Set([LOCAL]), captureTimeout: Infinity });
  /** While the second digit of a fret is written. */
  let joining = false;
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
  /** The line the cursor had last in each part it was in (docs/spec/commands.md, section 2). */
  const lines = new Map<string, number>(start ? [[start.partId, start.line]] : []);
  const refusedListeners = new Set<() => void>();
  const hintListeners = new Set<(hint: SessionHint) => void>();
  const textListeners = new Set<(request: TextRequest) => void>();
  let refused = false;
  /** Tell the member, the first time only, that a change was refused because the session is read-only. */
  function refuse(): void {
    if (refused) return;
    refused = true;
    for (const listener of refusedListeners) listener();
  }
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
      if (next) lines.set(next.partId, next.line);
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
   * Before each change of this member's: a new undo step, unless it is the second digit of a fret.
   * A change made elsewhere than by a key (a panel's) also ends the wait for a second digit.
   */
  const separate = (transaction: Y.Transaction): void => {
    if (transaction.origin !== LOCAL || joining) return;
    undo.stopCapturing();
    if (!running) lastDigit = null;
  };
  doc.on("beforeTransaction", separate);

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
      joining = true;
      try {
        return setFret(doc, at, previous.digit * 10 + digit);
      } finally {
        joining = false;
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

  /** A key that changes whole beats (docs/spec/commands.md, 5.3 and 5.6): every beat of the selection, which stays, else the cursor's beat. */
  const changeBeats = <D>(beatChange: BeatChange<D>): KeyCommand =>
    selectionOrCursor(
      (selected, at) => changeBeatsOnSelection(doc, selected, at, beatChange),
      (at) => changeBeatAt(doc, at, beatChange),
    );

  /**
   * Alt+1 and Alt+2: the voice of the staff. A fretted part offers only its first: Alt+2 there
   * does nothing, the selection stays, and the member is told so.
   */
  const toVoice = (voiceIndex: 0 | 1): KeyCommand => {
    const next = cursor && moveToVoice(doc, cursor, voiceIndex);
    if (next !== "notOffered") return move((at) => next ?? at);
    return {
      changes: false,
      run: (at) => {
        for (const listener of hintListeners) listener("oneVoice");
        return { cursor: at, selection };
      },
    };
  };

  /**
   * A technique key (docs/spec/commands.md, 5.4): on every note of the selection, which stays;
   * else on the note of the cursor's line (`noteKeyAt`), where dead and tie may make a note, and
   * a beat for it in the append slot.
   */
  function toggleNotes<D>(toggle: NoteToggle<D>): KeyCommand {
    return selectionOrCursor(
      (selected, at) => toggleOnSelection(doc, selected, at, toggle),
      (at) => {
        const key = noteKeyAt(doc, at);
        return key === null ? at : markAppended(at, (here) => toggleAt(doc, here, key, toggle));
      },
    );
  }

  /**
   * Enter: ask the shell for the text of the cursor's beat, which a box there then changes (one
   * command, `setText`).
   */
  const askForText: KeyCommand = {
    changes: false,
    leadsToChange: true,
    run: (at) => {
      const text = textAt(doc, at);
      if (text !== null) for (const listener of textListeners) listener({ cursor: at, text });
      return { cursor: at, selection };
    },
  };

  /** What a key runs, at the cursor (docs/spec/keymap.md, sections 2, 3, 4.1 and 5). */
  function commandOf(binding: SessionBinding, previous: TypedDigit | null): KeyCommand {
    const { effect } = binding;
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
      case "barStart":
        return move((at) => moveToBarStart(doc, at));
      case "barEnd":
        return move((at) => moveToBarEnd(doc, at));
      case "nextBar":
        return move((at) => moveByBar(doc, at, 1));
      case "previousBar":
        return move((at) => moveByBar(doc, at, -1));
      case "nextStaff":
        return move((at) => moveByStaff(doc, at, 1, lines));
      case "previousStaff":
        return move((at) => moveByStaff(doc, at, -1, lines));
      case "firstVoice":
        return toVoice(0);
      case "secondVoice":
        return toVoice(1);
      case "insertBeat":
        return change((at) => markAppended(at, (here) => insertBeat(doc, here)));
      case "delete":
        return selectionOrCursor(
          (selected, at) => deleteSelection(doc, selected, at),
          (at) => (isRestAt(doc, at) ? deleteBeat(doc, at) : deleteNote(doc, at)),
        );
      case "shorter":
        return changeBeats(durationStep(1));
      case "longer":
        return changeBeats(durationStep(-1));
      case "dots":
        return changeBeats(dotCycle);
      case "triplet":
        return changeBeats(tripletToggle);
      case "clear":
        return changeBeats(clearNotes);
      case "undo":
      case "redo":
        return change((at) => {
          if (effect === "redo") undo.redo();
          else undo.undo();
          return settled(at);
        });
      case "fret":
        return change((at) => typeDigit(binding.fret, at, previous));
      case "tie":
        return toggleNotes(tieToggle);
      case "slideOut":
        return toggleNotes(slideOutCycle);
      case "slideIn":
        return toggleNotes(slideInCycle);
      case "stroke":
        return changeBeats(strokeCycle);
      case "slapPop":
        return changeBeats(slapPopCycle);
      case "dynamic":
        return changeBeats(dynamicCycle);
      case "text":
        return askForText;
      default:
        // What is left are the on/off techniques: a new effect without a case of its own fails to type here.
        return toggleNotes(techniqueToggle(effect));
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
      if (binding === undefined || binding.native || binding.page || binding.context === "textEntry") return false;
      // Held down, only moves, + and - run again; the repeats of the others are still not the browser's.
      if (key.repeat === true && !binding.repeat) return true;
      // A digit waits for a second one; any other key that runs something ends the wait.
      const previous = lastDigit;
      lastDigit = null;
      const command = commandOf(binding, previous);
      if ((command.changes || command.leadsToChange) && readOnly) {
        refuse();
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
      // A click is not the second digit of a fret.
      lastDigit = null;
      putAt({ cursor: next, selection: null });
    },
    onRefused(listener) {
      refusedListeners.add(listener);
      return () => refusedListeners.delete(listener);
    },
    onHint(listener) {
      hintListeners.add(listener);
      return () => hintListeners.delete(listener);
    },
    onEditText(listener) {
      textListeners.add(listener);
      return () => textListeners.delete(listener);
    },
    setText(at, text) {
      if (readOnly) {
        refuse();
        return false;
      }
      // Not a key: a digit typed before it waits for no second one.
      lastDigit = null;
      if (!setText(doc, at, text)) return false;
      putAt({ cursor, selection: null });
      return true;
    },
    destroy() {
      doc.off("afterTransaction", settle);
      doc.off("beforeTransaction", separate);
      refusedListeners.clear();
      hintListeners.clear();
      textListeners.clear();
      presenceListeners.clear();
      undo.destroy();
    },
  };
}
