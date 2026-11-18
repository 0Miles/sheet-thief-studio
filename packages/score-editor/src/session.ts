// One member typing on a score: the cursor, the keys and the commands they run, and undo. Each
// key that changes the score is one command, one undo step. Nothing here touches the DOM, the
// renderer or the connection to the server, so any Y.Doc will do.
import {
  addPresetPart,
  appendBar,
  type BarRefusal,
  type BarSide,
  barsOf,
  bendCycle,
  bendStep,
  type BeatChange,
  beatPositionOf,
  changeBeatAt,
  changeBeatsOnSelection,
  clearNotes,
  type Cursor,
  type KeySignature,
  deleteBarsAt,
  deleteBeat,
  deleteNote,
  deletePart,
  deleteSelection,
  dotCycle,
  durationStep,
  dynamicCycle,
  enterNote,
  extendSelection,
  harmonicCycle,
  insertBarAt,
  insertBeat,
  isRestAt,
  LOCAL,
  metaOf,
  moveByBar,
  moveByBeat,
  moveByLine,
  moveByStaff,
  moveFromAppendedBeat,
  moveNotesByOctave,
  moveNotesBySemitone,
  movePart,
  moveToBarEnd,
  moveToBarStart,
  moveToVoice,
  DRUM_PIECES,
  noteKeysAt,
  type NoteToggle,
  type RepeatChange,
  replaceScore,
  type PartPresetId,
  type PartRefusal,
  partKindOf,
  partsOf,
  type Selection,
  type SelectionStep,
  setArtist,
  setCapo,
  setClef,
  setFret,
  setKeySig,
  setPartName,
  type PitchedClef,
  setProgram,
  setRepeat,
  setSection,
  setTempo,
  setText,
  setTimeSig,
  setTitle,
  setTuning,
  setVoltas,
  settleCursor,
  settleSelection,
  slapPopCycle,
  slideInCycle,
  slideOutCycle,
  startOfScore,
  strokeCycle,
  textAt,
  techniqueToggle,
  tieToggle,
  type TimeSignature,
  toggleAnacrusis,
  toggleDrum,
  toggleKeysAt,
  toggleOnSelection,
  tripletToggle,
  VOICE_NOT_OFFERED,
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
 * What the shell tells the member about a key or a command that did nothing: on a fretted part,
 * Alt+2, as such a part has one voice (「弦樂聲部只有一條聲線」, docs/spec/commands.md, section 3);
 * a bar inserted past `MAX_BARS` bars, or every bar deleted (`BarRefusal`, section 6); a part added
 * past the limits, or the last part deleted (`PartRefusal`, section 7).
 */
export type SessionHint = "oneVoice" | BarRefusal | PartRefusal;

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
  /**
   * Never a cursor: the Read view of a member who may change the score (a device that cannot be
   * typed on, docs/spec/views.md, section 5), where a restored version (`replaceScore`) is the only
   * change made. No key but undo and redo runs, and neither puts a cursor (docs/spec/collab.md, 8.5).
   */
  cursorless?: boolean;
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
  /** Put the cursor somewhere else (a click on the page), ending the selection. Never changes the score; never a cursor in a `cursorless` session. */
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
  /*
   * The structural commands the toolbar's buttons and the panel of the cursor's bar run, without a
   * key (docs/spec/commands.md, section 6): each one command, one undo step, refused while
   * read-only (the member is told, as for a key). False when nothing was done: read-only, no
   * cursor, a value out of range, or a refusal the member is told of (`onHint`).
   */
  /** Insert a bar before or after the cursor's, as Ctrl+Insert and Ctrl+Shift+Insert do. */
  insertBar(side: BarSide): boolean;
  /** The +bar button at the end of the score: a bar after the last, the cursor in it. */
  appendBar(): boolean;
  /** Delete the bars of the selection, else the cursor's, as Ctrl+Delete does. */
  deleteBars(): boolean;
  /** The time signature of the selection's bars, else of the cursor's bar up to the next change; the selection stays. */
  setTimeSig(timeSig: TimeSignature): boolean;
  /** The tempo from the cursor's bar on; null clears it. The selection stays. */
  setTempo(tempo: number | null): boolean;
  /** The key from the cursor's bar on; null clears it. The selection stays. */
  setKeySig(keySig: KeySignature | null): boolean;
  /** The name of the section that starts at the cursor's bar; null clears it. The selection stays. */
  setSection(section: string | null): boolean;
  /** A repeat over the selection's bars, else the cursor's, or its start or end cleared. The selection stays. */
  setRepeat(change: RepeatChange): boolean;
  /** The passes the selection's bars, else the cursor's, are played on; none clears them. The selection stays. */
  setVoltas(passes: readonly number[]): boolean;
  /** Make the first bar a pickup bar, or a full one again: false on any other bar. The selection stays. */
  toggleAnacrusis(): boolean;
  /*
   * The settings of the parts and of the score (docs/spec/commands.md, section 7), run from the
   * panel of the parts and the title bar, never by a key: each one command, one undo step,
   * refused while read-only (the member is told, as for a key). They need no cursor. The
   * selection ends, as after any command that does not work on it. False when nothing was done:
   * read-only, a part gone, a value out of range, or a refusal the member is told of (`onHint`).
   * There is no command that changes the kind of a part, its number of strings or staves.
   */
  /** Add a part of a preset after the last, a fretted one with `tuning` when given; refused past the limits (`"tooManyParts"`). */
  addPart(preset: PartPresetId, tuning?: readonly number[]): boolean;
  /** Delete a part with what it holds (the shell asks first); refused for the last (`"lastPart"`). A cursor in it goes to the start of the score. */
  deletePart(partId: string): boolean;
  /** Move a part right after another; null puts it first. */
  movePart(partId: string, after: string | null): boolean;
  setPartName(partId: string, name: string): boolean;
  /** A fretted part's tuning, as many strings as it has: frets stay. */
  setTuning(partId: string, tuning: readonly number[]): boolean;
  setCapo(partId: string, capo: number): boolean;
  /** Any part's but drums'. */
  setProgram(partId: string, program: number): boolean;
  /** The clef of a staff of a pitched part. */
  setClef(partId: string, staff: number, clef: PitchedClef): boolean;
  setTitle(title: string): boolean;
  /** An empty artist takes it away. */
  setArtist(artist: string): boolean;
  /**
   * Restore a version in place (docs/spec/collab.md, 8.5): the score becomes the version, its ids
   * kept, one undo step like any other command. The cursor stays where the version has its place,
   * else goes to the start of the score. False, nothing changed, when the version cannot be read
   * here (newer than this code, or not a score), or read-only.
   */
  replaceScore(version: unknown): boolean;
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
  run(at: Cursor): Outcome;
  /**
   * What it does when there is no cursor: its part and every bar gone, as when two members each
   * delete one of the last two bars. Only undo, redo and +bar have it, so that such a score can
   * be brought back (docs/spec/commands.md, section 9); any other command does nothing then.
   */
  runWithoutCursor?(): Outcome;
}

/** Where a command leaves the cursor and the selection; `done: false` when it did not do its work (refused, or a value out of range). */
interface Outcome extends LocalPresence {
  done?: false;
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

export function createEditorSession(doc: Y.Doc, { platform, cursor: start = null, readOnly = false, cursorless = false, now = () => Date.now() }: EditorSessionOptions): EditorSession {
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

  /**
   * The cursor was lost: its part or bar went, and the score had no place left to put it (no
   * bars, or no part that can be drawn). It comes back at the start of the score as soon as the
   * score has one again. So it is for a session started with no cursor on a score that has no
   * such place (no bars, or no parts, as two members deleting the last two at once leave it):
   * the cursor comes once a bar or a part does (docs/spec/commands.md, sections 7.3 and 9).
   */
  let stranded = !cursorless && start === null && startOfScore(doc) === null;

  /** Put the cursor and the selection there, and tell the presence when either moved. */
  function putAt({ cursor: next, selection: selected }: LocalPresence): void {
    if (next !== null) stranded = false;
    else if (cursor !== null) stranded = true;
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

  /**
   * The cursor on a place that exists, whatever changed the score: once its part or bar is gone,
   * the start of the score (docs/spec/commands.md, section 2).
   */
  const settled = (at: Cursor | null): Cursor | null => at && (settleCursor(doc, at, position) ?? startOfScore(doc, lines));
  /** `settled`, and for no cursor at all: the start of the score once the cursor was stranded, else still none. */
  const restored = (at: Cursor | null): Cursor | null => (at === null ? (stranded ? startOfScore(doc, lines) : null) : settled(at));
  const settle = (): void => {
    if (running) return;
    // A cursor put on a beat that had not arrived yet: its position is taken now that it is here.
    if (position === null && cursor !== null) position = beatPositionOf(doc, cursor);
    putAt({ cursor: restored(cursor), selection: selection && settleSelection(doc, selection) });
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
    if (next !== VOICE_NOT_OFFERED) return move((at) => next ?? at);
    return {
      changes: false,
      run: (at) => {
        hint("oneVoice");
        return { cursor: at, selection };
      },
    };
  };

  function hint(said: SessionHint): void {
    for (const listener of hintListeners) listener(said);
  }

  /**
   * A command that inserts or deletes bars (docs/spec/commands.md, section 6): the cursor goes
   * where it puts it, and the selection ends, its bars gone or not the ones worked on. Refused,
   * the member is told why, and nothing moves.
   */
  const structural = (run: (at: Cursor) => Cursor | BarRefusal): KeyCommand => ({
    changes: true,
    run: (at) => {
      const result = run(at);
      if (typeof result !== "string") return { cursor: result, selection: null };
      hint(result);
      return { cursor: at, selection, done: false };
    },
  });

  /** A structural command that changes bars where they are (a time signature, a tempo, a key, a repeat…): the cursor and the selection stay. */
  const onBars = (run: (at: Cursor, selected: Selection | null) => boolean): KeyCommand => ({
    changes: true,
    run: (at) => (run(at, selection) ? { cursor: at, selection } : { cursor: at, selection, done: false }),
  });

  /**
   * A setting of a part or of the score (docs/spec/commands.md, section 7): it needs no cursor.
   * The cursor settles where it is, at the start of the score once its part is deleted; the
   * selection ends. Refused, the member is told why when there is something to tell.
   */
  const setting = (run: () => boolean | string | null): KeyCommand => {
    const outcome = (at: Cursor | null): Outcome => {
      const result = run();
      const refused = result === "tooManyParts" || result === "lastPart";
      if (refused) hint(result);
      const cursorNow = restored(at);
      // Anything but a refusal or a value out of range is done: `addPresetPart` gives the new part's id.
      if (refused || result === false || result === null) {
        return { cursor: cursorNow, selection: selection && settleSelection(doc, selection), done: false };
      }
      return { cursor: cursorNow, selection: null };
    };
    return { changes: true, run: (at) => outcome(at), runWithoutCursor: () => outcome(null) };
  };

  /** Undo or redo this member's last step; the cursor, if it was lost, comes back at the start of the score. */
  const history = (effect: "undo" | "redo"): KeyCommand => {
    const step = () => (effect === "redo" ? undo.redo() : undo.undo());
    return {
      changes: true,
      run: (at) => {
        step();
        return { cursor: settled(at), selection: null };
      },
      runWithoutCursor: () => {
        step();
        return { cursor: cursorless ? null : startOfScore(doc, lines), selection: null };
      },
    };
  };

  /**
   * +bar: a bar after the last, the cursor in it; in a score left with no bars, the first bar, the
   * cursor at the start of the score (docs/spec/commands.md, section 9).
   */
  const addBarAtEnd: KeyCommand = {
    ...structural((at) => appendBar(doc, at) ?? at),
    runWithoutCursor: () => {
      const result = appendBar(doc, null);
      if (typeof result === "string") hint(result);
      if (typeof result === "string" || result === null) return { cursor: null, selection: null, done: false };
      // On the line the member had in that part.
      return { cursor: { ...result, line: lines.get(result.partId) ?? result.line }, selection: null };
    },
  };

  /**
   * A technique key (docs/spec/commands.md, 5.4): on every note of the selection, which stays;
   * else on the notes of the cursor's line (`noteKeysAt`: a string, or the drum pieces drawn on
   * the line), where dead and tie may make a note, and a beat for it in the append slot.
   */
  function toggleNotes<D>(toggle: NoteToggle<D>): KeyCommand {
    return selectionOrCursor(
      (selected, at) => toggleOnSelection(doc, selected, at, toggle),
      (at) => {
        const keys = noteKeysAt(doc, at);
        return keys.length === 0 ? at : markAppended(at, (here) => toggleKeysAt(doc, here, keys, toggle));
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

  /** What a key runs, at the cursor (docs/spec/keymap.md, sections 2, 3, 4.1, 4.2, 4.3 and 5). */
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
      case "insertBarBefore":
        return structural((at) => insertBarAt(doc, at, "before"));
      case "insertBarAfter":
        return structural((at) => insertBarAt(doc, at, "after"));
      case "deleteBars":
        return structural((at) => deleteBarsAt(doc, at, selection));
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
        return history(effect);
      case "fret":
        return change((at) => typeDigit(binding.fret, at, previous));
      case "drum":
        return change((at) => markAppended(at, (here) => toggleDrum(doc, here, DRUM_PIECES[binding.piece].id)));
      case "pitch":
        return change((at) => markAppended(at, (here) => enterNote(doc, here, binding.letter)));
      case "sharpen":
      case "flatten":
        return change((at) => moveNotesBySemitone(doc, at, effect === "sharpen" ? 1 : -1));
      case "octaveUp":
      case "octaveDown":
        return change((at) => moveNotesByOctave(doc, at, effect === "octaveUp" ? 1 : -1));
      case "tie":
        return toggleNotes(tieToggle);
      case "slideOut":
        return toggleNotes(slideOutCycle);
      case "slideIn":
        return toggleNotes(slideInCycle);
      case "bend":
        return toggleNotes(bendCycle);
      case "bendUp":
        return toggleNotes(bendStep(1));
      case "bendDown":
        return toggleNotes(bendStep(-1));
      case "harmonic":
        return toggleNotes(harmonicCycle);
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

  /** Whether a command can run now: at the cursor, or without one when it can (`runWithoutCursor`). */
  const runnable = (command: KeyCommand): boolean => cursor !== null || command.runWithoutCursor !== undefined;

  /**
   * Run a command at the cursor (without one, `runWithoutCursor`), unless it would change the score
   * of a read-only session. True when it ran and did its work.
   */
  function execute(command: KeyCommand): boolean {
    const at = cursor;
    if (!runnable(command)) return false;
    if ((command.changes || command.leadsToChange) && readOnly) {
      refuse();
      return false;
    }
    running = true;
    let next: Outcome;
    try {
      next = at === null ? command.runWithoutCursor!() : command.run(at);
    } finally {
      running = false;
    }
    putAt(next);
    return next.done !== false;
  }

  /** A command a button or the panel runs, not a key: a digit typed before it waits for no second one. True when it ran and did its work. */
  function runWithoutKey(command: KeyCommand): boolean {
    lastDigit = null;
    return execute(command);
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
      // A part whose kind cannot be read has no note keys (docs/spec/schema.md, section 11); nor has no cursor.
      const binding = matchKey(key, platform, cursor === null ? undefined : partKindOf(partsOf(doc).get(cursor.partId)));
      if (binding === undefined || binding.native || binding.page || binding.context === "textEntry") return false;
      // Without a cursor, only what can bring one back runs (undo, redo): any other key is left alone.
      if (cursor === null && binding.effect !== "undo" && binding.effect !== "redo") return false;
      // Held down, only moves, + and - run again; the repeats of the others are still not the browser's.
      if (key.repeat === true && !binding.repeat) return true;
      // A digit waits for a second one; any other key that runs something ends the wait.
      const previous = lastDigit;
      lastDigit = null;
      execute(commandOf(binding, previous));
      return true;
    },
    moveTo(next) {
      // A click is not the second digit of a fret.
      lastDigit = null;
      putAt({ cursor: cursorless ? null : next, selection: null });
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
    insertBar(side) {
      return runWithoutKey(structural((at) => insertBarAt(doc, at, side)));
    },
    appendBar() {
      return runWithoutKey(addBarAtEnd);
    },
    deleteBars() {
      return runWithoutKey(structural((at) => deleteBarsAt(doc, at, selection)));
    },
    setTimeSig(timeSig) {
      return runWithoutKey(onBars((at, selected) => setTimeSig(doc, at, selected, timeSig)));
    },
    setTempo(tempo) {
      return runWithoutKey(onBars((at) => setTempo(doc, at, tempo)));
    },
    setKeySig(keySig) {
      return runWithoutKey(onBars((at) => setKeySig(doc, at, keySig)));
    },
    setSection(section) {
      return runWithoutKey(onBars((at) => setSection(doc, at, section)));
    },
    setRepeat(change) {
      return runWithoutKey(onBars((at, selected) => setRepeat(doc, at, selected, change)));
    },
    setVoltas(passes) {
      return runWithoutKey(onBars((at, selected) => setVoltas(doc, at, selected, passes)));
    },
    toggleAnacrusis() {
      return runWithoutKey(onBars((at) => toggleAnacrusis(doc, at)));
    },
    addPart(preset, tuning) {
      return runWithoutKey(setting(() => addPresetPart(doc, preset, tuning)));
    },
    deletePart(partId) {
      return runWithoutKey(setting(() => deletePart(doc, partId)));
    },
    movePart(partId, after) {
      return runWithoutKey(setting(() => movePart(doc, partId, after)));
    },
    setPartName(partId, name) {
      return runWithoutKey(setting(() => setPartName(doc, partId, name)));
    },
    setTuning(partId, tuning) {
      return runWithoutKey(setting(() => setTuning(doc, partId, tuning)));
    },
    setCapo(partId, capo) {
      return runWithoutKey(setting(() => setCapo(doc, partId, capo)));
    },
    setProgram(partId, program) {
      return runWithoutKey(setting(() => setProgram(doc, partId, program)));
    },
    setClef(partId, staff, clef) {
      return runWithoutKey(setting(() => setClef(doc, partId, staff, clef)));
    },
    setTitle(title) {
      return runWithoutKey(setting(() => setTitle(doc, title)));
    },
    setArtist(artist) {
      return runWithoutKey(setting(() => setArtist(doc, artist)));
    },
    replaceScore(version) {
      return runWithoutKey(
        setting(() => {
          try {
            replaceScore(doc, version);
            return true;
          } catch {
            // Brought to this schema by the server already: a version that still cannot be read changes nothing.
            return false;
          }
        }),
      );
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
