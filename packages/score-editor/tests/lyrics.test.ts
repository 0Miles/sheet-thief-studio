// Lyrics mode (#50; docs/spec/keymap.md, 6.2): Shift+Enter on a staff asks for a box beside the
// beat; in it Space saves the syllable and goes on to the next sung beat, `-` saves it with a `-`,
// an empty box saves a melisma, Delete in an empty box takes the lyric away, Enter saves and
// leaves, Esc leaves. A key that goes to an input method does nothing.
import { expect, test } from "vitest";

import { createEditorSession, type LyricRequest, type LyricStep } from "../src/index";
import { keyOf, type Modifiers, sessionOn, undoEach } from "./support";

const shift = { shiftKey: true };

/**
 * A voice of two bars: C, a rest, E, F in the first, G in the second; the cursor in the append
 * slot after the G. Lyrics mode's requests are kept.
 */
function voice() {
  const on = sessionOn("pitched");
  const { press, session, barIds } = on;
  for (const key of ["c", "ArrowRight", "Insert", "ArrowRight", "e", "ArrowRight", "f", "ArrowRight", "g", "ArrowRight"]) press(key);
  const requests: LyricRequest[] = [];
  session.onEditLyric((request) => requests.push(request));
  const ids = (bar: number) => on.beats(bar).map((beat) => beat.id);
  const lyrics = () => [...on.beats(0), ...on.beats(1)].map((beat) => beat.lyric ?? null);
  /** Put the cursor on a beat of the first bar. */
  const onBeat = (index: number) => session.moveTo({ ...session.cursor!, barId: barIds[0]!, beatId: ids(0)[index]!, at: "on" });
  /** A key in the box of the last request, with `typed` in it. */
  const type = (typed: string, key: string, modifiers: Modifiers = {}): LyricStep => session.pressLyric(requests.at(-1)!, typed, keyOf(key, modifiers));
  /** The same, and the box goes on to the request the key gives, as the page's does. */
  const typeOn = (typed: string, key: string): LyricStep => {
    const step = type(typed, key);
    if (typeof step === "object" && step !== null) requests.push(step);
    return step;
  };
  return { ...on, requests, ids, lyrics, onBeat, type, typeOn };
}

test("Shift+Enter on a rest starts on the next sung beat, where the cursor goes; -, Space and an empty box save, past the rest and into the next bar, each one undo step", () => {
  const { press, session, requests, ids, lyrics, onBeat, type, typeOn, barIds } = voice();
  onBeat(1);
  expect(press("Enter", 1000, shift)).toBe(true);
  expect(session.cursor).toMatchObject({ beatId: ids(0)[2], at: "on" });
  expect(requests).toEqual([{ cursor: session.cursor, lyric: "" }]);

  expect(typeOn("Hel", "-")).toMatchObject({ cursor: { beatId: ids(0)[3] }, lyric: "" });
  expect(session.cursor).toMatchObject({ beatId: ids(0)[3] });
  expect(typeOn("lo", "Space")).toMatchObject({ cursor: { barId: barIds[1], beatId: ids(1)[0] } });
  // The last sung beat: an empty box is a melisma, and lyrics mode ends.
  expect(type("", "Space")).toBe("leave");
  expect(lyrics()).toEqual([null, null, "Hel-", "lo", ""]);
  expect(session.cursor).toMatchObject({ beatId: ids(1)[0] });
  undoEach(press, "other", lyrics, [
    [null, null, "Hel-", "lo", null],
    [null, null, "Hel-", null, null],
    [null, null, null, null, null],
  ]);
});

test("the box opens with the syllable the beat holds; Shift+Enter on a sung beat starts there; a syllable of 33 characters is refused and the box stays", () => {
  const { press, requests, ids, lyrics, onBeat, type, typeOn } = voice();
  onBeat(0);
  press("Enter", 1000, shift);
  expect(requests.at(-1)).toMatchObject({ cursor: { beatId: ids(0)[0] }, lyric: "" });
  typeOn("la", "Space");
  expect(type("a".repeat(33), "Space")).toBe("stay");
  // With its -, 33.
  expect(type("a".repeat(32), "-")).toBe("stay");
  expect(lyrics()).toEqual(["la", null, null, null, null]);
  expect(typeOn("a".repeat(32), "Space")).toMatchObject({ cursor: { beatId: ids(0)[3] } });
  expect(type("x", "Escape")).toBe("leave");
  expect(lyrics()).toEqual(["la", null, "a".repeat(32), null, null]);

  onBeat(0);
  press("Enter", 1000, shift);
  expect(requests.at(-1)).toMatchObject({ cursor: { beatId: ids(0)[0] }, lyric: "la" });
  expect(typeOn("la", "Space")).toMatchObject({ cursor: { beatId: ids(0)[2] }, lyric: "a".repeat(32) });
});

test("a Space, a -, an Enter, an Esc or a Delete that goes to an input method saves nothing and goes nowhere: Zhuyin chooses its word with them", () => {
  const { press, session, requests, lyrics, onBeat, type, doc } = voice();
  onBeat(0);
  press("Enter", 1000, shift);
  const at = session.cursor;
  let transactions = 0;
  doc.on("afterTransaction", () => (transactions += 1));
  for (const key of ["Space", "-", "Enter", "Escape", "Delete"]) {
    expect(type("", key, { isComposing: true })).toBeNull();
    expect(type("", key, { keyCode: 229 })).toBeNull();
  }
  expect(transactions).toBe(0);
  expect(session.cursor).toEqual(at);
  expect(requests).toHaveLength(1);
  // The word chosen, Space saves it.
  expect(type("你", "Space")).toMatchObject({ lyric: "" });
  expect(lyrics()[0]).toBe("你");
});

test("Delete in an empty box takes the beat's lyric away and goes on, with something typed it is the box's; Enter saves and leaves; every other key is the box's own", () => {
  const { press, session, requests, ids, lyrics, onBeat, type, typeOn } = voice();
  onBeat(0);
  press("Enter", 1000, shift);
  typeOn("Hel", "-");
  expect(type("lo", "Enter")).toBe("leave");
  expect(lyrics()).toEqual(["Hel-", null, "lo", null, null]);
  expect(session.cursor).toMatchObject({ beatId: ids(0)[2] });

  onBeat(0);
  press("Enter", 1000, shift);
  expect(type("Hel-", "Delete")).toBeNull();
  expect(typeOn("", "Delete")).toMatchObject({ cursor: { beatId: ids(0)[2] }, lyric: "lo" });
  expect(lyrics()).toEqual([null, null, "lo", null, null]);
  for (const key of ["a", "5", "Backspace", "ArrowLeft", "Tab"]) expect(type("lo", key)).toBeNull();
  expect(type("lo", "-", shift)).toBeNull();
  expect(requests).toHaveLength(4);
});

test("Shift+Enter is a staff's key only, asks nothing where the voice sings no more, and is refused while read-only", () => {
  const guitar = sessionOn("fretted");
  const asked: LyricRequest[] = [];
  guitar.session.onEditLyric((request) => asked.push(request));
  guitar.press("5");
  expect(guitar.press("Enter", 1000, shift)).toBe(false);
  expect(asked).toEqual([]);

  const { press, doc, session, requests, ids } = voice();
  // In the append slot after the G: nothing sung after it.
  expect(press("Enter", 1000, shift)).toBe(true);
  expect(requests).toEqual([]);

  const viewer = createEditorSession(doc, { platform: "other", readOnly: true, cursor: { ...session.cursor!, beatId: ids(1)[0]!, at: "on" } });
  let refused = 0;
  viewer.onRefused(() => (refused += 1));
  const seen: LyricRequest[] = [];
  viewer.onEditLyric((request) => seen.push(request));
  expect(viewer.press(keyOf("Enter", shift))).toBe(true);
  expect(refused).toBe(1);
  expect(seen).toEqual([]);
});
