// The editor session on its own: which keys it takes on each kind of part, and how it matches them.
import { partsOf, setNote } from "@studio/score-model";
import { expect, test } from "vitest";

import { keyOf, sessionOn } from "./support";

test.each(["percussion", "pitched"] as const)("digits enter frets only on a fretted part; the other keys work on a %s part", (kind) => {
  const { press, beats, cursor } = sessionOn(kind);
  expect(press("5")).toBe(false);
  expect(beats()).toEqual([]);
  expect(press("Insert")).toBe(true);
  expect(press("+")).toBe(true);
  expect(beats().map((beat) => [beat.value, beat.notes])).toEqual([[8, {}]]);
  expect(press("ArrowDown")).toBe(true);
  expect(cursor().line).toBe(5);
  // A rest: Delete takes the beat away.
  expect(press("Delete")).toBe(true);
  expect(beats()).toEqual([]);
  expect(press("z", 1000, { ctrlKey: true })).toBe(true);
  expect(beats().map((beat) => beat.value)).toEqual([8]);
  expect(press("z", 1000, { ctrlKey: true })).toBe(true);
  expect(beats().map((beat) => beat.value)).toEqual([4]);
});

test.each(["percussion", "pitched"] as const)("on a %s part, Delete leaves a beat with notes alone until its kind gets its note keys", (kind) => {
  const { doc, press, beats, cursor } = sessionOn(kind);
  press("Insert");
  setNote(doc, cursor(), kind === "percussion" ? "p38" : "n60", {});
  const before = beats();
  expect(press("Delete")).toBe(true);
  expect(beats()).toEqual(before);
});

test("shortcuts with a modifier are matched on where the key is, not on what it types", () => {
  const { session, press, beats } = sessionOn();
  press("7");
  // A Russian layout: the key in the place of Z types я.
  const russian = { key: "я", code: "KeyZ", ctrlKey: true };
  expect(session.press(russian)).toBe(true);
  expect(beats()).toEqual([]);
  // A French layout: the key that types z is where W is.
  const french = { key: "z", code: "KeyW", ctrlKey: true };
  expect(session.press(french)).toBe(false);
  expect(session.press({ code: "KeyY", ctrlKey: true })).toBe(true);
  expect(beats().map((beat) => beat.notes)).toEqual([{ s6: { fret: 7 } }]);
});

test("on a part whose kind cannot be read, digits are not keys and nothing throws", () => {
  const { doc, press, partId } = sessionOn();
  partsOf(doc).get(partId)!.set("kind", "banjo");
  expect(press("5")).toBe(false);
  expect(press("ArrowUp")).toBe(true);
});

test("digits, + and - are matched on where the key is, with an input method on, and on the numeric keypad", () => {
  const { session, beats } = sessionOn();
  // Zhuyin on: the key of 5 types ㄓ.
  const zhuyin = { key: "ㄓ", code: "Digit5" };
  expect(session.press(zhuyin)).toBe(true);
  expect(session.press({ code: "Equal" })).toBe(true);
  expect(beats().map((beat) => [beat.value, beat.notes])).toEqual([[8, { s6: { fret: 5 } }]]);
  expect(session.press({ code: "NumpadSubtract" })).toBe(true);
  expect(session.press({ code: "Minus" })).toBe(true);
  expect(beats()[0]!.value).toBe(2);
  expect(session.press({ code: "NumpadAdd" })).toBe(true);
  expect(session.press({ code: "Numpad7" })).toBe(true);
  expect(beats().map((beat) => [beat.value, beat.notes])).toEqual([[4, { s6: { fret: 7 } }]]);
  // A layout whose + is where - is on a US keyboard: what the key types does not matter.
  const swapped = { key: "+", code: "Minus" };
  session.press(swapped);
  expect(beats()[0]!.value).toBe(2);
});

test("on Windows and Linux, a key with one more modifier held is not that key", () => {
  const { press, beats } = sessionOn();
  press("7");
  // AltGr on a European keyboard is Ctrl+Alt; the Windows key is metaKey.
  expect(press("z", 1000, { ctrlKey: true, altKey: true })).toBe(false);
  expect(press("z", 1000, { metaKey: true })).toBe(false);
  expect(press("z", 1000, { ctrlKey: true, metaKey: true })).toBe(false);
  expect(press("Delete", 1000, { altKey: true })).toBe(false);
  expect(press("ArrowRight", 1000, { altKey: true })).toBe(false);
  expect(press("5", 1000, { ctrlKey: true })).toBe(false);
  expect(beats().map((beat) => beat.notes)).toEqual([{ s6: { fret: 7 } }]);
});

test("Shift+Delete and Shift+Insert are left to the browser, which cuts and pastes with them", () => {
  const { press, beats } = sessionOn();
  press("7");
  expect(press("Delete", 1000, { shiftKey: true })).toBe(false);
  expect(press("Insert", 1000, { shiftKey: true })).toBe(false);
  expect(beats().map((beat) => beat.notes)).toEqual([{ s6: { fret: 7 } }]);
});

test("on a Mac, Cmd undoes and redoes and Option+Return inserts; Ctrl+Z, Cmd+5 and Cmd+Y are not keys", () => {
  const { press, beats, cursor } = sessionOn("fretted", 2, "mac");
  press("7");
  expect(press("z", 1000, { ctrlKey: true })).toBe(false);
  expect(press("5", 1000, { metaKey: true })).toBe(false);
  expect(beats().map((beat) => beat.notes)).toEqual([{ s6: { fret: 7 } }]);
  expect(press("Insert")).toBe(false);
  expect(press("Enter", 1000, { altKey: true })).toBe(true);
  expect(beats().map((beat) => beat.notes)).toEqual([{}, { s6: { fret: 7 } }]);
  expect(cursor()).toMatchObject({ beatId: beats()[0]!.id });
  expect(press("z", 1000, { metaKey: true })).toBe(true);
  expect(beats()).toHaveLength(1);
  // Cmd+Y is the history of Safari and Chrome.
  expect(press("y", 1000, { metaKey: true })).toBe(false);
  expect(beats()).toHaveLength(1);
  expect(press("z", 1000, { metaKey: true, shiftKey: true })).toBe(true);
  expect(beats()).toHaveLength(2);
});

test.each(["other", "mac"] as const)("on %s, copy, cut and paste are left to the browser, and run no other key", (platform) => {
  const { press, beats } = sessionOn("fretted", 2, platform);
  const mod = platform === "mac" ? { metaKey: true } : { ctrlKey: true };
  press("7");
  // false: the shell does not call preventDefault, and the browser fires copy, cut and paste.
  for (const key of ["c", "x", "v"]) expect(press(key, 1000, mod)).toBe(false);
  expect(beats().map((beat) => beat.notes)).toEqual([{ s6: { fret: 7 } }]);
});

test("a key that goes to an input method runs nothing, the keydown that ends the composition included", () => {
  const { session, press, beats, cursor } = sessionOn();
  const before = cursor();
  for (const key of ["5", "ArrowRight", "Insert", "Delete", "+"]) {
    expect(session.press(keyOf(key, { isComposing: true }))).toBe(false);
    expect(session.press(keyOf(key, { keyCode: 229 }))).toBe(false);
  }
  expect(session.press(keyOf("z", { ctrlKey: true, isComposing: true }))).toBe(false);
  expect(beats()).toEqual([]);
  expect(cursor()).toBe(before);
  expect(press("5")).toBe(true);
});

test("held down, a move, + and - repeat; a digit, Insert, Delete, undo and redo do not", () => {
  const { session, press, beats, cursor } = sessionOn();
  const held = (key: string, modifiers = {}) => session.press(keyOf(key, { ...modifiers, repeat: true }));
  press("1");
  // A repeat is still the session's key: it is not handed to the browser.
  expect(held("1")).toBe(true);
  expect(held("Insert")).toBe(true);
  expect(beats().map((beat) => [beat.value, beat.notes])).toEqual([[4, { s6: { fret: 1 } }]]);
  expect(held("+")).toBe(true);
  expect(held("+")).toBe(true);
  expect(held("-")).toBe(true);
  expect(beats()[0]!.value).toBe(8);
  expect(held("Delete")).toBe(true);
  expect(held("z", { ctrlKey: true })).toBe(true);
  expect(held("y", { ctrlKey: true })).toBe(true);
  expect(beats().map((beat) => [beat.value, beat.notes])).toEqual([[8, { s6: { fret: 1 } }]]);
  expect(held("ArrowUp")).toBe(true);
  expect(held("ArrowUp")).toBe(true);
  expect(cursor().line).toBe(4);
});

test("a key that runs nothing does not end the wait for a second digit", () => {
  const { press, beats } = sessionOn();
  press("1");
  // Ctrl on its own, then Ctrl+C: neither runs a command here.
  expect(press("ControlLeft", 100, { ctrlKey: true })).toBe(false);
  expect(press("c", 100, { ctrlKey: true })).toBe(false);
  expect(press("F5", 100)).toBe(false);
  press("2", 100);
  expect(beats()[0]!.notes.s6).toEqual({ fret: 12 });
});
