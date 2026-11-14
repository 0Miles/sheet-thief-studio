// Moving through a score with the session's keys (docs/spec/commands.md, section 3; keymap.md,
// section 2): Home and End, by bar, through staves and parts, and between voices, on one staff,
// on two, across parts, in the first bar and in the last, with the keys of both platforms.
import { expect, test } from "vitest";

import type { Key } from "../src/index";
import { band, PLATFORMS } from "./band";

test.each(PLATFORMS)("on %s, Home and End go to the first place of the bar and to the last one → reaches, on a staff of its own or one of two", (platform) => {
  const { press, place, goTo } = band(platform);
  // The guitar's first bar is not full: End is its append slot.
  expect(press("End")).toBe(true);
  expect(place()).toEqual(["guitar", 0, "0:0", 1, "after"]);
  expect(press("Home")).toBe(true);
  expect(place()).toEqual(["guitar", 0, "0:0", 0, "on"]);
  // The keyboard's lower staff is full with its whole: End stays on it.
  goTo("keys", 0, "1:0");
  press("End");
  expect(place()).toEqual(["keys", 0, "1:0", 0, "on"]);
  // The upper staff's second voice holds a half.
  goTo("keys", 0, "0:1");
  press("End");
  expect(place()).toEqual(["keys", 0, "0:1", 0, "after"]);
  // An empty bar of another part: both are its append slot.
  goTo("drums", 1, "0:0", -1);
  press("Home");
  expect(place()).toEqual(["drums", 1, "0:0", -1, "after"]);
  press("End");
  expect(place()).toEqual(["drums", 1, "0:0", -1, "after"]);
  // The last bar, full.
  goTo("keys", 2, "0:0", 1);
  press("Home");
  expect(place()).toEqual(["keys", 2, "0:0", 0, "on"]);
  press("End");
  expect(place()).toEqual(["keys", 2, "0:0", 1, "after"]);
  goTo("guitar", 2);
  press("End");
  expect(place()).toEqual(["guitar", 2, "0:0", 0, "on"]);
});

test.each(PLATFORMS)("on %s, Nav+→ and Nav+← go to the first place of the next bar and the one before, and stay at either end of the score", (platform) => {
  const { press, place, goTo, mods } = band(platform);
  press("ArrowRight");
  // The first bar: it stays.
  expect(press("ArrowLeft", mods.nav)).toBe(true);
  expect(place()).toEqual(["guitar", 0, "0:0", 1, "on"]);
  expect(press("ArrowRight", mods.nav)).toBe(true);
  expect(place()).toEqual(["guitar", 1, "0:0", -1, "after"]);
  press("ArrowRight", mods.nav);
  expect(place()).toEqual(["guitar", 2, "0:0", 0, "on"]);
  // The last bar: it stays.
  press("ArrowRight", mods.nav);
  expect(place()).toEqual(["guitar", 2, "0:0", 0, "on"]);
  // On the second of two staves, the cursor keeps to its staff.
  goTo("keys", 2, "0:0", 1);
  press("ArrowDown", mods.nav);
  press("ArrowLeft", mods.nav);
  expect(place()).toEqual(["keys", 1, "1:0", -1, "after"]);
  press("ArrowLeft", mods.nav);
  expect(place()).toEqual(["keys", 0, "1:0", 0, "on"]);
  // The first bar: it stays.
  press("ArrowLeft", mods.nav);
  expect(place()).toEqual(["keys", 0, "1:0", 0, "on"]);
});

test.each(PLATFORMS)("on %s, Nav+↓ goes through the staves of each part, then to the next part, onto the beat that holds the cursor's tick; Nav+↑ goes back", (platform) => {
  const { press, place, goTo, mods } = band(platform);
  // The guitar's quarter starts half way through the bar.
  goTo("guitar", 0, "0:0", 1);
  const down = [0, 1, 2, 3].map(() => {
    expect(press("ArrowDown", mods.nav)).toBe(true);
    return place();
  });
  expect(down).toEqual([
    ["keys", 0, "0:0", 2, "on"],
    ["keys", 0, "1:0", 0, "on"],
    ["drums", 0, "0:0", -1, "after"],
    ["drums", 0, "0:0", -1, "after"], // the last staff of the last part
  ]);
  const up = [0, 1, 2, 3].map(() => {
    press("ArrowUp", mods.nav);
    return place();
  });
  // From an empty voice the tick is the start of the bar.
  expect(up).toEqual([
    ["keys", 0, "1:0", 0, "on"],
    ["keys", 0, "0:0", 0, "on"],
    ["guitar", 0, "0:0", 0, "on"],
    ["guitar", 0, "0:0", 0, "on"], // the first staff of the first part
  ]);
});

test.each(PLATFORMS)("on %s, Nav+↑/↓ in the last bar stays in it, part after part", (platform) => {
  const { press, place, goTo, mods } = band(platform);
  goTo("guitar", 2);
  press("ArrowDown", mods.nav);
  expect(place()).toEqual(["keys", 2, "0:0", 0, "on"]);
  press("ArrowDown", mods.nav);
  expect(place()).toEqual(["keys", 2, "1:0", -1, "after"]);
  press("ArrowDown", mods.nav);
  expect(place()).toEqual(["drums", 2, "0:0", 0, "on"]);
});

test("in each part the cursor comes back on the line it had there; the first time, on the part's first string or middle line", () => {
  const { session, press } = band();
  const line = () => session.cursor!.line;
  expect(line()).toBe(1);
  press("ArrowDown");
  press("ArrowDown");
  press("ArrowDown", { ctrlKey: true });
  expect(line()).toBe(4);
  press("ArrowUp");
  press("ArrowUp", { ctrlKey: true });
  expect(line()).toBe(3);
  press("ArrowDown", { ctrlKey: true });
  // Through the staves of one part, the line stays.
  press("ArrowDown", { ctrlKey: true });
  expect(line()).toBe(3);
  press("ArrowDown", { ctrlKey: true });
  expect(line()).toBe(4);
});

test.each(PLATFORMS)("on %s, Alt+2 and Alt+1 go to the second and the first voice of the staff, onto the beat that holds the cursor's tick", (platform) => {
  const { press, place, goTo, mods, hints } = band(platform);
  goTo("keys", 0, "0:0", 1);
  expect(press("2", mods.alt)).toBe(true);
  expect(place()).toEqual(["keys", 0, "0:1", 0, "on"]);
  // The half starts the bar: back in the first voice, on the beat that starts there.
  expect(press("1", mods.alt)).toBe(true);
  expect(place()).toEqual(["keys", 0, "0:0", 0, "on"]);
  // The voice the cursor is in already: it stays.
  press("1", mods.alt);
  expect(place()).toEqual(["keys", 0, "0:0", 0, "on"]);
  // The lower staff's second voice is empty.
  goTo("keys", 0, "1:0");
  press("2", mods.alt);
  expect(place()).toEqual(["keys", 0, "1:1", -1, "after"]);
  // The last bar, on the drums.
  goTo("drums", 2);
  press("2", mods.alt);
  expect(place()).toEqual(["drums", 2, "0:1", -1, "after"]);
  press("1", mods.alt);
  expect(place()).toEqual(["drums", 2, "0:0", 0, "on"]);
  expect(hints).toEqual([]);
});

test.each(PLATFORMS)("on %s, a fretted part has one voice: Alt+2 does not move the cursor, and the member is told so", (platform) => {
  const { press, place, mods, hints, session } = band(platform);
  const told: unknown[] = [];
  session.onPresence((presence) => told.push(presence));
  expect(press("2", mods.alt)).toBe(true);
  expect(place()).toEqual(["guitar", 0, "0:0", 0, "on"]);
  expect(hints).toEqual(["oneVoice"]);
  expect(press("1", mods.alt)).toBe(true);
  expect(hints).toEqual(["oneVoice"]);
  expect(told).toEqual([]);
});

test("on a Mac, Ctrl with the arrows is not a key (macOS takes it); on Windows and Linux, Option's Alt with the arrows is not either", () => {
  const mac = band("mac");
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) expect(mac.press(key, { ctrlKey: true })).toBe(false);
  expect(mac.place()).toEqual(["guitar", 0, "0:0", 0, "on"]);
  const other = band("other");
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) expect(other.press(key, { altKey: true })).toBe(false);
  expect(other.place()).toEqual(["guitar", 0, "0:0", 0, "on"]);
  // Cmd with the arrows is back and forward in a Mac's browser.
  expect(mac.press("ArrowRight", { metaKey: true })).toBe(false);
  expect(mac.place()).toEqual(["guitar", 0, "0:0", 0, "on"]);
});

/** A key as a keyboard of another layout sends it: what it types is not where it is. */
function typed(key: string, code: string, modifiers: Omit<Key, "code"> = {}): Key {
  const sent = { key, code, ...modifiers };
  return sent;
}

test("keys are matched on where they are, whatever they type: Option+1 types ¡ on a Mac, Alt+2 is é on a French keyboard, Shift+T is Y on Dvorak", () => {
  const mac = band("mac");
  mac.goTo("keys", 0, "0:0", 1);
  expect(mac.session.press(typed("™", "Digit2", { altKey: true }))).toBe(true);
  expect(mac.place()).toEqual(["keys", 0, "0:1", 0, "on"]);
  expect(mac.session.press(typed("¡", "Digit1", { altKey: true }))).toBe(true);
  expect(mac.place()).toEqual(["keys", 0, "0:0", 0, "on"]);
  const french = band("other");
  french.goTo("keys", 0, "0:0", 1);
  expect(french.session.press(typed("é", "Digit2", { altKey: true }))).toBe(true);
  expect(french.place()).toEqual(["keys", 0, "0:1", 0, "on"]);
  // The key that types 2 with Shift on that keyboard, where Q is on a US one, is not Alt+2.
  expect(french.session.press(typed("2", "KeyQ", { altKey: true }))).toBe(false);
  // Home and End on a French keyboard are where they are anywhere; End is "Fin" on its keycap only.
  expect(french.session.press(typed("End", "End"))).toBe(true);
  expect(french.place()).toEqual(["keys", 0, "0:1", 0, "after"]);
  const dvorak = band("other");
  expect(dvorak.session.press(typed("Y", "KeyT", { shiftKey: true }))).toBe(true);
  expect(dvorak.beats("guitar", 0)[0]!.tuplet).toEqual({ actual: 3, normal: 2 });
  // On Dvorak the key that types T is where K is: Shift+K is tap, not a triplet.
  expect(dvorak.session.press(typed("T", "KeyK", { shiftKey: true }))).toBe(true);
  expect(dvorak.beats("guitar", 0)[0]!.tuplet).toEqual({ actual: 3, normal: 2 });
  expect(dvorak.beats("guitar", 0)[0]!.notes).toEqual({ s1: { fret: 5, tap: true } });
});

test("moving by bar, staff or voice never changes the score, and held down it runs again", () => {
  const { doc, session, press, place } = band();
  let transactions = 0;
  doc.on("afterTransaction", () => (transactions += 1));
  for (const [key, modifiers] of [
    ["End", {}],
    ["Home", {}],
    ["ArrowRight", { ctrlKey: true }],
    ["ArrowDown", { ctrlKey: true }],
    ["2", { altKey: true }],
    ["ArrowUp", { ctrlKey: true }],
    ["ArrowLeft", { ctrlKey: true }],
  ] as const) {
    expect(press(key, modifiers)).toBe(true);
  }
  expect(transactions).toBe(0);
  expect(place()).toEqual(["guitar", 0, "0:0", 0, "on"]);
  session.press({ code: "ArrowRight", ctrlKey: true, repeat: true });
  session.press({ code: "ArrowRight", ctrlKey: true, repeat: true });
  expect(place()).toEqual(["guitar", 2, "0:0", 0, "on"]);
});

test("a move without Shift ends the selection: Home, End, by bar, by staff, by voice", () => {
  for (const [key, modifiers] of [
    ["Home", {}],
    ["End", {}],
    ["ArrowRight", { ctrlKey: true }],
    ["ArrowDown", { ctrlKey: true }],
    ["1", { altKey: true }],
  ] as const) {
    const { session, press, goTo } = band();
    goTo("keys", 0);
    press("ArrowRight", { shiftKey: true });
    expect(session.selection).not.toBeNull();
    press(key, modifiers);
    expect(session.selection).toBeNull();
  }
});
