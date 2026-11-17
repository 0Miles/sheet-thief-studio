// The structural keys and the commands of the toolbar and the panel of the cursor's bar
// (docs/spec/commands.md, section 6; docs/spec/keymap.md, sections 2 and 5): bars inserted and
// deleted for every part, time signatures and tempo, each one undo step, on both platforms.
import { barsOf, cursorAt, deleteBarsAt, docToJson, insertBarAt, insertBars, ordered } from "@studio/score-model";
import { describe, expect, test } from "vitest";

import { createEditorSession, type KeyPlatform } from "../src/index";
import { band, PLATFORMS } from "./band";
import { otherMember, sessionOn } from "./support";

/** The keys of each structural command on each platform, as a keyboard sends them (keymap.md, section 2). */
const KEYS = {
  other: {
    insertBefore: [{ code: "Insert", ctrlKey: true }],
    insertAfter: [{ code: "Insert", ctrlKey: true, shiftKey: true }],
    deleteBars: [{ code: "Delete", ctrlKey: true }],
  },
  // Cmd+Return; Cmd+delete, the key marked delete sending Backspace, and Cmd+Fn+delete sending Delete.
  mac: {
    insertBefore: [{ code: "Enter", metaKey: true }],
    insertAfter: [{ code: "Enter", metaKey: true, shiftKey: true }],
    deleteBars: [
      { code: "Backspace", metaKey: true },
      { code: "Delete", metaKey: true },
    ],
  },
} as const;

const UNDO = { other: { code: "KeyZ", ctrlKey: true }, mac: { code: "KeyZ", metaKey: true } } as const;

/** The band score, and its bars as their index among the bars written (-1 for a new one). */
function score(platform: KeyPlatform = "other") {
  const setup = band(platform);
  const bars = () => docToJson(setup.doc).bars.map((bar) => setup.barIds.indexOf(bar.id));
  return { ...setup, bars };
}

describe.each(PLATFORMS)("on %s", (platform) => {
  test("the keys of Insert bar put an empty bar before or after the cursor's, in every part, and the cursor there", () => {
    for (const before of KEYS[platform].insertBefore) {
      const { doc, session, goTo, bars, partIds } = score(platform);
      goTo("guitar", 1, "0:0", -1);
      expect(session.press(before)).toBe(true);
      expect(bars()).toEqual([0, -1, 1, 2]);
      const added = docToJson(doc).bars[1]!.id;
      expect(session.cursor).toMatchObject({ partId: partIds.guitar, barId: added, voice: "0:0", beatId: null, at: "after" });
      for (const part of docToJson(doc).parts) expect(part.content[added]).toBeDefined();
      session.press(UNDO[platform]);
      expect(bars()).toEqual([0, 1, 2]);
    }
    for (const after of KEYS[platform].insertAfter) {
      const { session, goTo, bars } = score(platform);
      goTo("keys", 2);
      expect(session.press(after)).toBe(true);
      expect(bars()).toEqual([0, 1, 2, -1]);
    }
  });

  test("the keys of Delete bar delete the cursor's bar from every part, one undo step that brings it back with what it held", () => {
    for (const key of KEYS[platform].deleteBars) {
      const { doc, session, place, bars } = score(platform);
      const before = docToJson(doc);
      expect(session.press(key)).toBe(true);
      expect(bars()).toEqual([1, 2]);
      // The first place of the bar after, in the cursor's own voice: the second bar is empty.
      expect(place()).toEqual(["guitar", 1, "0:0", -1, "after"]);
      session.press(UNDO[platform]);
      expect(docToJson(doc)).toEqual(before);
    }
  });

  test("the keys of Delete bar delete the bars of a bar range, and the selection ends", () => {
    const { session, press, bars, mods } = score(platform);
    press("ArrowRight", { ...mods.nav, shiftKey: true });
    expect(session.selection).toMatchObject({ kind: "bars" });
    session.press(KEYS[platform].deleteBars[0]);
    expect(bars()).toEqual([2]);
    expect(session.selection).toBeNull();
  });

  test("the last bar is never deleted: the member is told so, and the selection stays", () => {
    const { session, press, bars, hints, mods } = score(platform);
    press("ArrowRight", { ...mods.nav, shiftKey: true });
    press("ArrowRight", { ...mods.nav, shiftKey: true });
    const selection = session.selection;
    session.press(KEYS[platform].deleteBars[0]);
    expect(bars()).toEqual([0, 1, 2]);
    expect(hints).toEqual(["lastBar"]);
    expect(session.selection).toEqual(selection);
  });
});

test("on a Mac, Ctrl+Insert and Ctrl+Delete do nothing, and Option+Return is still Insert, a beat", () => {
  const { session, bars, beats } = score("mac");
  expect(session.press({ code: "Insert", ctrlKey: true })).toBe(false);
  expect(session.press({ code: "Delete", ctrlKey: true })).toBe(false);
  expect(session.press({ code: "Insert", metaKey: true })).toBe(false);
  expect(bars()).toEqual([0, 1, 2]);
  expect(session.press({ code: "Enter", altKey: true })).toBe(true);
  expect(bars()).toEqual([0, 1, 2]);
  expect(beats("guitar", 0)).toHaveLength(3);
});

test("on Windows and Linux, the Mac's Cmd+Return and Cmd+Backspace do nothing", () => {
  const { session, bars } = score("other");
  expect(session.press({ code: "Enter", metaKey: true })).toBe(false);
  expect(session.press({ code: "Backspace", metaKey: true })).toBe(false);
  expect(session.press({ code: "Backspace", ctrlKey: true })).toBe(false);
  expect(bars()).toEqual([0, 1, 2]);
});

test("read-only, the structural keys and commands are refused, and the member is told once", () => {
  const { doc, partIds, barIds } = band();
  const session = createEditorSession(doc, { platform: "other", readOnly: true, cursor: { partId: partIds.guitar, barId: barIds[0]!, voice: "0:0", beatId: null, at: "after", line: 1 } });
  let refused = 0;
  session.onRefused(() => refused++);
  const before = docToJson(doc);
  expect(session.press(KEYS.other.insertBefore[0])).toBe(true);
  expect(session.press(KEYS.other.deleteBars[0])).toBe(true);
  expect(session.insertBar("after")).toBe(false);
  expect(session.appendBar()).toBe(false);
  expect(session.deleteBars()).toBe(false);
  expect(session.setTimeSig({ numerator: 3, denominator: 4 })).toBe(false);
  expect(session.setTempo(90)).toBe(false);
  expect(docToJson(doc)).toEqual(before);
  expect(refused).toBe(1);
});

test("the toolbar's buttons insert, append and delete bars as the keys do, each one undo step", () => {
  const { doc, session, bars, barIds } = score();
  expect(session.insertBar("before")).toBe(true);
  expect(bars()).toEqual([-1, 0, 1, 2]);
  expect(session.appendBar()).toBe(true);
  expect(bars()).toEqual([-1, 0, 1, 2, -1]);
  expect(session.cursor!.barId).toBe(docToJson(doc).bars.at(-1)!.id);
  expect(session.deleteBars()).toBe(true);
  expect(bars()).toEqual([-1, 0, 1, 2]);
  expect(session.cursor!.barId).toBe(barIds[2]);
  session.press(UNDO.other);
  session.press(UNDO.other);
  expect(bars()).toEqual([-1, 0, 1, 2]);
  session.press(UNDO.other);
  expect(bars()).toEqual([0, 1, 2]);
});

test("the panel sets the time signature of a bar range, which stays selected, and the tempo of the cursor's bar, each one undo step", () => {
  const { doc, session, press, mods } = score();
  const signatures = () => docToJson(doc).bars.map((bar) => `${bar.timeSig.numerator}/${bar.timeSig.denominator}`);
  press("ArrowRight", { ...mods.nav, shiftKey: true });
  const selection = session.selection;
  expect(session.setTimeSig({ numerator: 3, denominator: 4 })).toBe(true);
  expect(signatures()).toEqual(["3/4", "3/4", "4/4"]);
  expect(session.selection).toEqual(selection);
  expect(session.setTempo(96)).toBe(true);
  expect(docToJson(doc).bars.map((bar) => bar.tempo)).toEqual([undefined, 96, undefined]);
  expect(session.setTempo(1000)).toBe(false);
  expect(session.setTimeSig({ numerator: 3, denominator: 5 } as never)).toBe(false);
  session.press(UNDO.other);
  expect(docToJson(doc).bars.map((bar) => bar.tempo)).toEqual([undefined, undefined, undefined]);
  session.press(UNDO.other);
  expect(signatures()).toEqual(["4/4", "4/4", "4/4"]);
});

test("a change of the panel between two digits ends the wait for the second", () => {
  const { session, press, goTo, beats } = score();
  goTo("guitar", 0, "0:0", 0, 3);
  press("1");
  session.setTempo(100);
  press("2");
  expect(beats("guitar", 0)[0]!.notes.s3).toEqual({ fret: 2 });
});

test("a bar inserted past 1000 bars is refused, and the member is told so", () => {
  const { doc, session, hints, barIds } = score();
  // 997 more bars, written without the session: 1000 in all.
  for (let count = 0; count < 997; count++) insertBarAt(doc, { ...session.cursor!, barId: barIds[2]! }, "after");
  expect(docToJson(doc).bars).toHaveLength(1000);
  expect(session.insertBar("after")).toBe(false);
  expect(session.press(KEYS.other.insertBefore[0])).toBe(true);
  expect(hints).toEqual(["tooManyBars", "tooManyBars"]);
  expect(docToJson(doc).bars).toHaveLength(1000);
});

test("when another member deletes the bar the cursor is in, the cursor goes to the start of the score, on the line it had in that part", () => {
  const { doc, session, goTo, partIds, barIds } = score();
  goTo("keys", 2, "0:0", 0, 6);
  goTo("guitar", 2, "0:0", 0, 4);
  const { other, send } = otherMember(doc);
  deleteBarsAt(other, session.cursor!, null);
  send();
  expect(barsOf(doc).has(barIds[2]!)).toBe(false);
  expect(session.cursor).toMatchObject({ partId: partIds.guitar, barId: barIds[0], voice: "0:0", at: "on", line: 4 });
});

test("undoing the insertion of the bar the cursor is in takes the cursor to the start of the score", () => {
  const { session, press, barIds, partIds, mods } = score();
  press("ArrowRight", mods.nav);
  press("Insert", mods.mod);
  expect(session.cursor!.barId).not.toBe(barIds[1]);
  session.press(UNDO.other);
  expect(session.cursor).toMatchObject({ partId: partIds.guitar, barId: barIds[0], at: "on" });
});

/** Two bars, this member deleting the first while another deletes the second: no bars are left. */
function noBarsLeft(platform: KeyPlatform = "other") {
  const setup = sessionOn("fretted", 2, platform);
  const { doc, session, partId, barIds } = setup;
  const { other, send } = otherMember(doc);
  expect(session.press(KEYS[platform].deleteBars[0])).toBe(true);
  deleteBarsAt(other, cursorAt(other, partId, barIds[1]!), null);
  send();
  expect(ordered(barsOf(doc))).toEqual([]);
  expect(session.cursor).toBeNull();
  return { ...setup, other, send };
}

test.each(PLATFORMS)("on %s, a score two members left with no bars is brought back by undo, though the cursor is gone", (platform) => {
  const { doc, session, partId, barIds } = noBarsLeft(platform);
  // Only undo and redo run without a cursor; any other key is left alone.
  expect(session.press({ code: "Digit5" })).toBe(false);
  expect(session.press(KEYS[platform].insertBefore[0])).toBe(false);
  expect(session.press(UNDO[platform])).toBe(true);
  expect(ordered(barsOf(doc))).toEqual([barIds[0]]);
  // On the line the member had in that part.
  expect(session.cursor).toEqual(cursorAt(doc, partId, barIds[0]!, 6));
});

test("in a score left with no bars, +bar makes the first bar, the cursor in it, and typing goes on", () => {
  const { doc, session, press } = noBarsLeft();
  expect(session.appendBar()).toBe(true);
  const [bar] = ordered(barsOf(doc));
  expect(session.cursor).toMatchObject({ barId: bar, beatId: null, at: "after" });
  expect(press("7")).toBe(true);
  // On the line the member had in that part.
  expect(docToJson(doc).parts[0]!.content[bar!]!["0:0"]!.map((beat) => beat.notes)).toEqual([{ s6: { fret: 7 } }]);
  // One undo step each: the fret, then the bar.
  session.press(UNDO.other);
  session.press(UNDO.other);
  expect(ordered(barsOf(doc))).toEqual([]);
  expect(session.cursor).toBeNull();
});

test("a cursor lost with the last bars comes back at the start of the score when another member adds a bar", () => {
  const { doc, session, other, send, partId } = noBarsLeft();
  const [bar] = insertBars(other, { after: null, count: 1 });
  send();
  expect(session.cursor).toEqual(cursorAt(doc, partId, bar!, 6));
});
