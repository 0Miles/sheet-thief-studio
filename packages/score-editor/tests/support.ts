// What the tests of the editor share: a score to type on, and keys as a keyboard sends them.
import { addPart, createScore, cursorAt, docToJson, insertBars, type PartKind, type Staff } from "@studio/score-model";
import { expect } from "vitest";
import * as Y from "yjs";

import { createEditorSession, type Key, type KeyPlatform } from "../src/index";

/** The modifiers held, and the rest of a keyboard event but where the key is. */
export type Modifiers = Omit<Key, "code">;

/** A key as a US keyboard sends it, named by what it types: `code` is where the key is. */
export function keyOf(key: string, modifiers: Modifiers = {}): Key {
  const code = /^[0-9]$/.test(key) ? `Digit${key}` : /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : key === "+" ? "Equal" : key === "-" ? "Minus" : key === "." ? "Period" : key;
  return { code, ...(key === "+" ? { shiftKey: true } : {}), ...modifiers };
}

/** Another member's copy of the score, and a way to hand their changes to ours. */
export function otherMember(doc: Y.Doc) {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  const send = () => Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(doc)));
  return { other, send };
}

/**
 * A score of empty bars (two unless told) and one part, an editor session on it with the cursor
 * in the append slot of the first bar and the keys of Windows and Linux unless told, and a clock
 * the test moves. `staves` gives the part its staves (a keyboard's two), its kind's own unless told.
 */
export function sessionOn(kind: PartKind = "fretted", bars = 2, platform: KeyPlatform = "other", staves?: Staff[]) {
  const doc = new Y.Doc();
  createScore(doc, "Demo");
  const barIds = insertBars(doc, { after: null, count: bars });
  const partId = addPart(doc, { name: "Part", kind, ...(staves && { staves }) });
  const clock = { now: 0 };
  const session = createEditorSession(doc, { platform, cursor: cursorAt(doc, partId, barIds[0]!, kind === "fretted" ? 6 : 4), now: () => clock.now });
  /** Press a key `wait` milliseconds after the one before; true when the session handled it. */
  const press = (key: string, wait = 1000, modifiers: Modifiers = {}): boolean => {
    clock.now += wait;
    return session.press(keyOf(key, modifiers));
  };
  const beats = (bar = 0, voice = "0:0") => docToJson(doc).parts[0]!.content[barIds[bar]!]![voice]!;
  return { doc, session, press, beats, cursor: () => session.cursor!, barIds, partId };
}

/**
 * Press undo on `platform` once for each of `states`, the session's `press` pressing it: what
 * `read` reads goes back to each in turn, one undo step each.
 */
export function undoEach(press: ReturnType<typeof sessionOn>["press"], platform: KeyPlatform, read: () => unknown, states: unknown[]): void {
  const undo = platform === "mac" ? { metaKey: true } : { ctrlKey: true };
  for (const state of states) {
    press("z", 1000, undo);
    expect(read()).toEqual(state);
  }
}
