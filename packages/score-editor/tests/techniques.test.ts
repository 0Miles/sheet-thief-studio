// The keys of the techniques of a note (docs/spec/keymap.md, section 3): Shift and a letter turns
// one on the note of the cursor's string on and off, or on every note of the selection.
import { cursorAt } from "@studio/score-model";
import { expect, test } from "vitest";

import { createEditorSession } from "../src/index";
import { keyOf, sessionOn } from "./support";

const shift = { shiftKey: true };

const TECHNIQUES = [
  ["x", "dead"],
  ["g", "ghost"],
  ["a", "accent"],
  ["c", "staccato"],
  ["v", "vibrato"],
  ["p", "palmMute"],
  ["i", "letRing"],
  ["k", "tap"],
  ["h", "legato"],
] as const;

test.each(["other", "mac"] as const)("on %s, each Shift+letter turns its technique on the note of the cursor's string on, then off, one undo step each", (platform) => {
  const undo = platform === "mac" ? { metaKey: true } : { ctrlKey: true };
  for (const [letter, field] of TECHNIQUES) {
    const { press, beats } = sessionOn("fretted", 2, platform);
    press("5");
    expect(press(letter, 1000, shift)).toBe(true);
    expect(beats()[0]!.notes).toEqual({ s6: { fret: 5, [field]: true } });
    press(letter, 1000, shift);
    expect(beats()[0]!.notes).toEqual({ s6: { fret: 5 } });
    press("z", 1000, undo);
    expect(beats()[0]!.notes).toEqual({ s6: { fret: 5, [field]: true } });
    press("z", 1000, undo);
    expect(beats()[0]!.notes).toEqual({ s6: { fret: 5 } });
  }
});

test("on a string with no note, Shift+X makes a dead note without a fret, and the other technique keys do nothing", () => {
  const { press, beats } = sessionOn();
  press("5");
  press("ArrowUp");
  for (const [letter] of TECHNIQUES.slice(1)) expect(press(letter, 1000, shift)).toBe(true);
  expect(beats()[0]!.notes).toEqual({ s6: { fret: 5 } });
  press("x", 1000, shift);
  expect(beats()[0]!.notes).toEqual({ s6: { fret: 5 }, s5: { dead: true } });
  press("z", 1000, { ctrlKey: true });
  expect(beats()[0]!.notes).toEqual({ s6: { fret: 5 } });
});

test("Shift+X in the append slot makes a beat with a dead note there; the next → goes on from it", () => {
  const { press, beats, cursor } = sessionOn();
  press("x", 1000, shift);
  expect(beats().map((beat) => beat.notes)).toEqual([{ s6: { dead: true } }]);
  expect(cursor()).toMatchObject({ beatId: beats()[0]!.id, at: "on" });
  press("ArrowRight");
  expect(cursor()).toMatchObject({ beatId: beats()[0]!.id, at: "after" });
});

test("with a selection, a technique key turns the technique on every note of it, and the selection stays", () => {
  const { press, beats, session } = sessionOn();
  press("1");
  press("ArrowRight");
  press("2");
  press("ArrowRight");
  press("3");
  press("ArrowLeft");
  press("g", 1000, shift);
  press("ArrowLeft");
  press("ArrowRight", 1000, shift);
  const selection = session.selection;
  expect(selection).toMatchObject({ kind: "beats" });
  press("g", 1000, shift);
  expect(beats().map((beat) => beat.notes.s6)).toEqual([
    { fret: 1, ghost: true },
    { fret: 2, ghost: true },
    { fret: 3 },
  ]);
  expect(session.selection).toEqual(selection);
  press("g", 1000, shift);
  expect(beats().map((beat) => beat.notes.s6)).toEqual([{ fret: 1 }, { fret: 2 }, { fret: 3 }]);
  // One undo step for the whole selection.
  press("z", 1000, { ctrlKey: true });
  expect(beats().map((beat) => beat.notes.s6)).toEqual([{ fret: 1, ghost: true }, { fret: 2, ghost: true }, { fret: 3 }]);
});

test("held down, a technique key does not turn its technique on and off again", () => {
  const { session, press, beats } = sessionOn();
  press("5");
  press("v", 1000, shift);
  expect(session.press(keyOf("v", { shiftKey: true, repeat: true }))).toBe(true);
  expect(beats()[0]!.notes).toEqual({ s6: { fret: 5, vibrato: true } });
});

test("while read-only, a technique key changes nothing", () => {
  const { doc, beats, barIds, partId, press, session: writer } = sessionOn();
  press("5");
  writer.destroy();
  const session = createEditorSession(doc, { platform: "other", cursor: cursorAt(doc, partId, barIds[0]!, 6), readOnly: true });
  let refused = 0;
  session.onRefused(() => (refused += 1));
  expect(session.press(keyOf("x", shift))).toBe(true);
  expect(beats()[0]!.notes).toEqual({ s6: { fret: 5 } });
  expect(refused).toBe(1);
});

test.each(["percussion", "pitched"] as const)("on a %s part, the fretted technique keys are not the session's", (kind) => {
  const { press } = sessionOn(kind);
  for (const [letter] of [...TECHNIQUES, ["s"], ["e"]]) expect(press(letter!, 1000, shift)).toBe(false);
});

test("on Windows and on a Mac, Shift+L ties the note of the cursor's string to the one before, taking its fret, and again unties it, one undo step each", () => {
  for (const platform of ["other", "mac"] as const) {
    const undo = platform === "mac" ? { metaKey: true } : { ctrlKey: true };
    const { press, beats } = sessionOn("fretted", 2, platform);
    press("5");
    press("ArrowRight");
    press("7");
    expect(press("l", 1000, shift)).toBe(true);
    expect(beats().map((beat) => beat.notes.s6)).toEqual([{ fret: 5 }, { fret: 5, tie: true }]);
    press("l", 1000, shift);
    expect(beats().map((beat) => beat.notes.s6)).toEqual([{ fret: 5 }, { fret: 5 }]);
    press("z", 1000, undo);
    press("z", 1000, undo);
    expect(beats().map((beat) => beat.notes.s6)).toEqual([{ fret: 5 }, { fret: 7 }]);
  }
});

test("Shift+L on a string with no note makes the note before's fret there, tied; in the append slot on a new beat", () => {
  const { press, beats, cursor } = sessionOn();
  press("5");
  press("ArrowRight");
  press("l", 1000, shift);
  expect(beats().map((beat) => beat.notes)).toEqual([{ s6: { fret: 5 } }, { s6: { fret: 5, tie: true } }]);
  expect(cursor()).toMatchObject({ beatId: beats()[1]!.id, at: "on" });
});

test("with a selection, Shift+L ties every note of it, and the selection stays", () => {
  const { press, beats, session } = sessionOn();
  press("1");
  press("ArrowRight");
  press("2");
  press("ArrowLeft");
  press("ArrowRight", 1000, shift);
  const selection = session.selection;
  expect(selection).toMatchObject({ kind: "beats" });
  press("l", 1000, shift);
  expect(beats().map((beat) => beat.notes.s6)).toEqual([{ fret: 1, tie: true }, { fret: 1, tie: true }]);
  expect(session.selection).toEqual(selection);
});

test("on Windows and on a Mac, Shift+S steps the note of the cursor's string through the slides out, and Shift+E through the slides in, one undo step each", () => {
  for (const platform of ["other", "mac"] as const) {
    const undo = platform === "mac" ? { metaKey: true } : { ctrlKey: true };
    const { press, beats } = sessionOn("fretted", 2, platform);
    press("5");
    const outs = [1, 2, 3, 4, 5].map(() => {
      expect(press("s", 1000, shift)).toBe(true);
      return beats()[0]!.notes.s6!.slideOut ?? null;
    });
    expect(outs).toEqual(["legato", "shift", "outUp", "outDown", null]);
    const ins = [1, 2, 3].map(() => {
      expect(press("e", 1000, shift)).toBe(true);
      return beats()[0]!.notes.s6!.slideIn ?? null;
    });
    expect(ins).toEqual(["inBelow", "inAbove", null]);
    press("z", 1000, undo);
    expect(beats()[0]!.notes).toEqual({ s6: { fret: 5, slideIn: "inAbove" } });
  }
});

test("with a selection, Shift+S takes every note of it to one slide, and the selection stays", () => {
  const { press, beats, session } = sessionOn();
  press("1");
  press("ArrowRight");
  press("2");
  press("s", 1000, shift);
  press("ArrowLeft");
  press("ArrowRight", 1000, shift);
  const selection = session.selection;
  press("s", 1000, shift);
  expect(beats().map((beat) => beat.notes.s6!.slideOut)).toEqual(["legato", "legato"]);
  expect(session.selection).toEqual(selection);
});
