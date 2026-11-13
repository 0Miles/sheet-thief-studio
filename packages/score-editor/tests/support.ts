// What the tests of the editor share: a score to type on, and keys as a keyboard sends them.
import { addPart, createScore, cursorAt, docToJson, insertBars, type PartKind } from "@studio/score-model";
import * as Y from "yjs";

import { createEditorSession, type Key } from "../src/index";

type Modifiers = Pick<Key, "ctrlKey" | "metaKey" | "shiftKey">;

/** A key as a US keyboard sends it: `code` names where the key is, `key` what it types. */
export function keyOf(key: string, modifiers: Modifiers = {}): Key {
  const code = /^[0-9]$/.test(key) ? `Digit${key}` : /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : key === "+" ? "Equal" : key === "-" ? "Minus" : key;
  return { key, code, ...(key === "+" ? { shiftKey: true } : {}), ...modifiers };
}

/**
 * A score of two empty bars and one part, an editor session on it with the cursor on the first
 * bar, and a clock the test moves.
 */
export function sessionOn(kind: PartKind = "fretted") {
  const doc = new Y.Doc();
  createScore(doc, "Demo");
  const barIds = insertBars(doc, { after: null, count: 2 });
  const partId = addPart(doc, { name: "Part", kind });
  const clock = { now: 0 };
  const session = createEditorSession(doc, { cursor: cursorAt(doc, partId, barIds[0]!, kind === "fretted" ? 6 : 4), now: () => clock.now });
  /** Press a key `wait` milliseconds after the one before; true when the session handled it. */
  const press = (key: string, wait = 1000, modifiers: Modifiers = {}): boolean => {
    clock.now += wait;
    return session.press(keyOf(key, modifiers));
  };
  const beats = (bar = 0) => docToJson(doc).parts[0]!.content[barIds[bar]!]!["0:0"]!;
  return { doc, session, press, beats, cursor: () => session.cursor!, barIds, partId };
}
