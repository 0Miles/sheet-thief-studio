// The keys of the markings of a beat (docs/spec/keymap.md, sections 3, 5 and 6): Shift+U strokes,
// Shift+J slaps and pops, Shift+F gives a dynamic, and Enter opens the text of the beat, whose
// box saves it with Enter and leaves it with Esc, a key that ends a composition doing neither.
import { cursorAt } from "@studio/score-model";
import { expect, test } from "vitest";

import { createEditorSession, type TextRequest, textEntryEffectOf } from "../src/index";
import { band, PLATFORMS } from "./band";
import { keyOf } from "./support";

const shift = { shiftKey: true };

test.each(PLATFORMS)("on %s, Shift+U strokes the guitar's beat down, up, then not at all, each one undo step", (platform) => {
  const { press, beats, mods } = band(platform);
  const stroke = () => beats("guitar", 0)[0]!.stroke ?? null;
  expect(press("u", shift)).toBe(true);
  expect(stroke()).toBe("down");
  press("u", shift);
  expect(stroke()).toBe("up");
  press("u", shift);
  expect(stroke()).toBeNull();
  press("z", mods.mod);
  expect(stroke()).toBe("up");
  press("z", mods.mod);
  press("z", mods.mod);
  expect(stroke()).toBeNull();
});

test.each(PLATFORMS)("on %s, Shift+J slaps the guitar's beat, then pops it, then neither, each one undo step", (platform) => {
  const { press, beats, mods } = band(platform);
  const state = () => {
    const { slap, pop } = beats("guitar", 0)[0]!;
    return [slap ?? null, pop ?? null];
  };
  expect(press("j", shift)).toBe(true);
  expect(state()).toEqual([true, null]);
  press("j", shift);
  expect(state()).toEqual([null, true]);
  press("j", shift);
  expect(state()).toEqual([null, null]);
  press("z", mods.mod);
  expect(state()).toEqual([null, true]);
});

test.each(PLATFORMS)("on %s, Shift+F steps the dynamic of the beat on every kind of part, each one undo step", (platform) => {
  const { press, beats, goTo, mods } = band(platform);
  expect(press("f", shift)).toBe(true);
  press("f", shift);
  expect(beats("guitar", 0)[0]!.dynamic).toBe("p");
  goTo("keys", 0, "1:0");
  press("f", shift);
  expect(beats("keys", 0, "1:0")[0]!.dynamic).toBe("pp");
  goTo("drums", 2);
  press("f", shift);
  expect(beats("drums", 2)[0]!.dynamic).toBe("pp");
  press("z", mods.mod);
  expect(beats("drums", 2)[0]!.dynamic).toBeUndefined();
  press("z", mods.mod);
  press("z", mods.mod);
  expect(beats("guitar", 0)[0]!.dynamic).toBe("pp");
});

test("on drums and staves, Shift+U and Shift+J are no keys of theirs, and change nothing", () => {
  const { press, goTo, doc } = band();
  goTo("drums", 2);
  let transactions = 0;
  doc.on("afterTransaction", () => (transactions += 1));
  expect(press("u", shift)).toBe(false);
  expect(press("j", shift)).toBe(false);
  goTo("keys", 0);
  expect(press("u", shift)).toBe(false);
  expect(press("j", shift)).toBe(false);
  expect(transactions).toBe(0);
});

test.each(PLATFORMS)("on %s, over a selection, Shift+U, Shift+J and Shift+F change every beat of it, and the selection stays", (platform) => {
  const { session, press, beats, goTo, mods } = band(platform);
  goTo("keys", 0);
  press("ArrowRight", shift);
  press("ArrowRight", shift);
  const selected = session.selection;
  press("f", shift);
  expect(beats("keys", 0).map((beat) => beat.dynamic ?? null)).toEqual(["pp", "pp", "pp", null]);
  expect(session.selection).toEqual(selected);
  // A bar range of the guitar, its last bar among them.
  goTo("guitar", 1, "0:0", -1);
  press("ArrowRight", { ...mods.nav, ...shift });
  press("u", shift);
  press("j", shift);
  expect(beats("guitar", 2).map(({ stroke, slap }) => [stroke, slap])).toEqual([["down", true]]);
  expect(beats("guitar", 0).every((beat) => beat.stroke === undefined)).toBe(true);
});

test.each(PLATFORMS)("on %s, Enter asks for the text of the cursor's beat, on every kind of part, and its text is saved in one undo step", (platform) => {
  const { session, press, beats, goTo, mods, partIds } = band(platform);
  const requests: TextRequest[] = [];
  session.onEditText((request) => requests.push(request));
  expect(press("Enter")).toBe(true);
  expect(requests).toEqual([{ cursor: session.cursor, text: "" }]);
  expect(session.setText(requests[0]!.cursor, "Am7")).toBe(true);
  expect(beats("guitar", 0)[0]!.text).toBe("Am7");
  // The text it holds is the one asked to change, on the numeric keypad's Enter as well.
  expect(press("NumpadEnter")).toBe(true);
  expect(requests[1]!.text).toBe("Am7");
  session.setText(requests[1]!.cursor, "");
  expect(beats("guitar", 0)[0]!.text).toBeUndefined();
  press("z", mods.mod);
  expect(beats("guitar", 0)[0]!.text).toBe("Am7");
  press("z", mods.mod);
  expect(beats("guitar", 0)[0]!.text).toBeUndefined();
  goTo("keys", 0, "1:0");
  press("Enter");
  goTo("drums", 2);
  press("Enter");
  expect(requests.slice(2).map((request) => request.cursor.partId)).toEqual([partIds.keys, partIds.drums]);
  session.setText(requests[2]!.cursor, "rit.");
  session.setText(requests[3]!.cursor, "fill");
  expect(beats("keys", 0, "1:0")[0]!.text).toBe("rit.");
  expect(beats("drums", 2)[0]!.text).toBe("fill");
});

test("Enter asks for nothing in the append slot, and a text of 65 characters is refused", () => {
  const { session, press, beats } = band();
  const requests: TextRequest[] = [];
  session.onEditText((request) => requests.push(request));
  const on = session.cursor!;
  press("ArrowRight");
  press("ArrowRight");
  expect(session.cursor).toMatchObject({ at: "after" });
  expect(press("Enter")).toBe(true);
  expect(requests).toEqual([]);
  expect(session.setText(on, "a".repeat(65))).toBe(false);
  expect(beats("guitar", 0)[0]!.text).toBeUndefined();
});

test("saving a text ends the selection, as a command that does not work on it", () => {
  const { session, press } = band();
  press("ArrowRight", shift);
  expect(session.selection).not.toBeNull();
  const requests: TextRequest[] = [];
  session.onEditText((request) => requests.push(request));
  press("Enter");
  expect(session.selection).not.toBeNull();
  session.setText(requests[0]!.cursor, "C");
  expect(session.selection).toBeNull();
});

test("while read-only, Shift+U, Shift+J and Shift+F change nothing, Enter asks for no text, and a text is not saved", () => {
  const { doc, partIds, barIds, session: writer } = band();
  writer.destroy();
  const session = createEditorSession(doc, { platform: "other", cursor: cursorAt(doc, partIds.guitar, barIds[0]!), readOnly: true });
  let refused = 0;
  session.onRefused(() => (refused += 1));
  const requests: TextRequest[] = [];
  session.onEditText((request) => requests.push(request));
  const before = JSON.stringify(doc.toJSON());
  for (const key of ["u", "j", "f"]) expect(session.press(keyOf(key, shift))).toBe(true);
  expect(session.press(keyOf("Enter"))).toBe(true);
  expect(requests).toEqual([]);
  expect(session.setText(session.cursor!, "C")).toBe(false);
  expect(JSON.stringify(doc.toJSON())).toBe(before);
  expect(refused).toBe(1);
});

test.each(PLATFORMS)("on %s, in a text box, Enter saves and Esc leaves; a key that goes to the input method does neither", (platform) => {
  expect(textEntryEffectOf(keyOf("Enter"), platform)).toBe("saveEntry");
  expect(textEntryEffectOf(keyOf("NumpadEnter"), platform)).toBe("saveEntry");
  expect(textEntryEffectOf(keyOf("Escape"), platform)).toBe("cancelEntry");
  // Choosing a word with Enter: while composing, and the keydown with which Safari ends a composition.
  expect(textEntryEffectOf(keyOf("Enter", { isComposing: true }), platform)).toBeNull();
  expect(textEntryEffectOf(keyOf("Enter", { keyCode: 229 }), platform)).toBeNull();
  expect(textEntryEffectOf(keyOf("Escape", { isComposing: true }), platform)).toBeNull();
  expect(textEntryEffectOf(keyOf("Escape", { keyCode: 229 }), platform)).toBeNull();
  // The letters typed and the keys of the score are the box's own.
  for (const key of [keyOf("a"), keyOf("a", shift), keyOf("5"), keyOf("Enter", shift), keyOf("z", { ctrlKey: true }), keyOf("Delete"), keyOf("Space")]) expect(textEntryEffectOf(key, platform)).toBeNull();
});
