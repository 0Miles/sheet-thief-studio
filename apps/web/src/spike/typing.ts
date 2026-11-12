// Keyboard entry on a fretted part: each key is one command on the score, and one undo step.
import { barsOf, type Cursor, insertBeat, LOCAL, moveByBeat, moveByLine, partsOf, setFret, settleCursor, stepDuration, valueAt } from "@studio/score-model";
import * as Y from "yjs";

/** Two digits typed within this many milliseconds make one two-digit fret. */
export const TWO_DIGIT_WINDOW = 600;

/** The highest fret that can be typed. */
const MAX_FRET = 36;

/** The part of a keyboard event the typing reads. */
export interface Key {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export interface Typing {
  /**
   * What a key does at a cursor: the cursor afterwards, or undefined when the key is not one
   * of the typing keys (the event is then left alone).
   */
  press(key: Key, cursor: Cursor): Cursor | undefined;
  undo: Y.UndoManager;
}

export function createTyping(doc: Y.Doc, now: () => number = () => performance.now()): Typing {
  // Only what this member did is undone (docs/adr/0001); one command, one step.
  const undo = new Y.UndoManager([barsOf(doc), partsOf(doc)], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
  let lastDigit: { digit: number; at: number; cursor: Cursor } | null = null;

  function typeDigit(digit: number, cursor: Cursor): Cursor {
    const previous = lastDigit;
    const second =
      previous !== null &&
      now() - previous.at <= TWO_DIGIT_WINDOW &&
      previous.cursor.beatId === cursor.beatId &&
      previous.cursor.line === cursor.line &&
      previous.digit * 10 + digit <= MAX_FRET;
    if (second && previous) {
      // The second digit completes the fret: it joins the undo step of the first.
      lastDigit = null;
      undo.captureTimeout = TWO_DIGIT_WINDOW * 2;
      try {
        return setFret(doc, cursor, previous.digit * 10 + digit);
      } finally {
        undo.captureTimeout = 0;
      }
    }
    let next = cursor;
    doc.transact(() => {
      // In an empty bar the first digit also makes the beat it goes on.
      if (next.beatId === null) next = insertBeat(doc, next, { value: 4 });
      setFret(doc, next, digit);
    }, LOCAL);
    lastDigit = { digit, at: now(), cursor: next };
    return next;
  }

  function press(key: Key, cursor: Cursor): Cursor | undefined {
    const command = key.ctrlKey === true || key.metaKey === true;
    if (command) {
      const name = key.key.toLowerCase();
      if (name !== "z" && name !== "y") return undefined;
      lastDigit = null;
      if (name === "y" || key.shiftKey === true) undo.redo();
      else undo.undo();
      return settleCursor(doc, cursor) ?? cursor;
    }
    if (/^[0-9]$/.test(key.key)) return typeDigit(Number(key.key), cursor);
    lastDigit = null;
    switch (key.key) {
      case "ArrowRight":
        return moveByBeat(doc, cursor, 1);
      case "ArrowLeft":
        return moveByBeat(doc, cursor, -1);
      case "ArrowDown":
        return moveByLine(doc, cursor, 1);
      case "ArrowUp":
        return moveByLine(doc, cursor, -1);
      case "Insert":
        return insertBeat(doc, cursor, { value: valueAt(doc, cursor) ?? 4 });
      case "+":
        return stepDuration(doc, cursor, 1);
      case "-":
        return stepDuration(doc, cursor, -1);
      case "Delete":
        return setFret(doc, cursor, null);
      default:
        return undefined;
    }
  }

  return { press, undo };
}
