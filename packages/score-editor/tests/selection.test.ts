// Selecting in the editor session (docs/spec/commands.md, section 4): a beat range in one voice
// of one bar, a bar range in one part, how each is extended and collapsed, and Delete on them.
import { addPart, contentOf, cursorAt, docToJson, partsOf, setFret } from "@studio/score-model";
import { expect, test } from "vitest";

import { createEditorSession, type LocalPresence } from "../src/index";
import { keyOf, otherMember, sessionOn } from "./support";

/** A session whose first bar holds quarter beats with these frets, the cursor on the first of them. */
function typed(frets: number[], bars = 3, platform: "other" | "mac" = "other") {
  const on = sessionOn("fretted", bars, platform);
  for (const [index, fret] of frets.entries()) {
    if (index > 0) on.press("ArrowRight");
    on.press(String(fret));
  }
  for (let index = 1; index < frets.length; index++) on.press("ArrowLeft");
  return { ...on, ids: on.beats().map((beat) => beat.id) };
}

const shift = { shiftKey: true };

test("Shift+→ and Shift+← extend a beat range from the beat the cursor was on; the focus follows the cursor", () => {
  const { session, press, ids, partId, barIds } = typed([1, 2, 3]);
  expect(press("ArrowRight", 1000, shift)).toBe(true);
  expect(press("ArrowRight", 1000, shift)).toBe(true);
  expect(session.selection).toEqual({ kind: "beats", partId, barId: barIds[0], voice: "0:0", anchorBeatId: ids[0], focusBeatId: ids[2] });
  expect(session.cursor).toMatchObject({ beatId: ids[2], at: "on" });
  press("ArrowLeft", 1000, shift);
  expect(session.selection).toMatchObject({ kind: "beats", anchorBeatId: ids[0], focusBeatId: ids[1] });
  expect(session.presence()).toEqual({ cursor: session.cursor, selection: session.selection });
});

test("Shift+→ past the end of a beat range's bar makes it the range of bars from its bar to the cursor's, and it stays one", () => {
  const { session, press, ids, partId, barIds } = typed([1, 2, 3, 4]);
  for (let step = 0; step < 3; step++) press("ArrowRight", 1000, shift);
  expect(session.selection).toMatchObject({ kind: "beats", anchorBeatId: ids[0], focusBeatId: ids[3] });
  // The bar is full: → goes on to the next bar.
  press("ArrowRight", 1000, shift);
  expect(session.cursor).toMatchObject({ barId: barIds[1], beatId: null, at: "after" });
  expect(session.selection).toEqual({ kind: "bars", partId, anchorBarId: barIds[0], focusBarId: barIds[1] });
  press("ArrowRight", 1000, shift);
  expect(session.selection).toEqual({ kind: "bars", partId, anchorBarId: barIds[0], focusBarId: barIds[2] });
  // Back in the bar it started in, it is still a bar range: of that one bar.
  press("ArrowLeft", 1000, shift);
  press("ArrowLeft", 1000, shift);
  expect(session.cursor).toMatchObject({ barId: barIds[0], beatId: ids[3] });
  expect(session.selection).toEqual({ kind: "bars", partId, anchorBarId: barIds[0], focusBarId: barIds[0] });
});

test("in a bar that is not full, Shift+→ into the append slot keeps the range up to the last beat; one more goes on to the next bar", () => {
  const { session, press, ids, barIds } = typed([1, 2]);
  press("ArrowRight", 1000, shift);
  press("ArrowRight", 1000, shift);
  expect(session.cursor).toMatchObject({ beatId: ids[1], at: "after" });
  expect(session.selection).toMatchObject({ kind: "beats", anchorBeatId: ids[0], focusBeatId: ids[1] });
  press("ArrowRight", 1000, shift);
  expect(session.selection).toMatchObject({ kind: "bars", anchorBarId: barIds[0], focusBarId: barIds[1] });
});

test("Shift+← from the first beat of a bar makes the range of bars from the bar before to the bar it started in", () => {
  const { session, press, barIds, partId } = typed([1, 2]);
  press("ArrowRight");
  press("ArrowRight");
  press("ArrowRight");
  press("5");
  expect(session.cursor).toMatchObject({ barId: barIds[1], at: "on" });
  press("ArrowLeft", 1000, shift);
  expect(session.cursor).toMatchObject({ barId: barIds[0] });
  expect(session.selection).toEqual({ kind: "bars", partId, anchorBarId: barIds[1], focusBarId: barIds[0] });
});

test("in an empty voice there is no beat to select: Shift+← at the start of the score selects nothing", () => {
  const { session, press } = sessionOn();
  expect(press("ArrowLeft", 1000, shift)).toBe(true);
  expect(session.selection).toBeNull();
});

test.each([
  ["→", "ArrowRight", {}],
  ["←", "ArrowLeft", {}],
  ["↑", "ArrowUp", {}],
  ["↓", "ArrowDown", {}],
  ["Esc", "Escape", {}],
  ["a digit", "7", {}],
  ["+", "+", {}],
  ["Insert", "Insert", {}],
  ["undo", "z", { ctrlKey: true }],
])("%s ends the selection", (_, key, modifiers) => {
  const { session, press } = typed([1, 2, 3]);
  press("ArrowRight", 1000, shift);
  expect(session.selection).not.toBeNull();
  expect(press(key, 1000, modifiers)).toBe(true);
  expect(session.selection).toBeNull();
  expect(session.presence().selection).toBeNull();
});

test("a click on the page ends the selection; Esc without a selection changes nothing", () => {
  const { session, press, cursor } = typed([1, 2, 3]);
  press("ArrowRight", 1000, shift);
  const at = cursor();
  session.moveTo({ ...at, line: 3 });
  expect(session.selection).toBeNull();
  expect(press("Escape")).toBe(true);
  expect(session.cursor).toMatchObject({ beatId: at.beatId, line: 3 });
});

test.each([
  ["Windows and Linux", "other", { ctrlKey: true, shiftKey: true }],
  ["a Mac", "mac", { altKey: true, shiftKey: true }],
] as const)("on %s, Shift with Nav and ←/→ extends a bar range from the cursor's bar, the cursor on each bar's first place", (_, platform, modifiers) => {
  const { session, press, ids, partId, barIds } = typed([1, 2], 3, platform);
  press("ArrowRight");
  expect(press("ArrowRight", 1000, modifiers)).toBe(true);
  expect(session.cursor).toMatchObject({ barId: barIds[1], beatId: null, at: "after" });
  expect(session.selection).toEqual({ kind: "bars", partId, anchorBarId: barIds[0], focusBarId: barIds[1] });
  press("ArrowRight", 1000, modifiers);
  // At the end of the score the cursor stays, and so does the range.
  press("ArrowRight", 1000, modifiers);
  expect(session.selection).toEqual({ kind: "bars", partId, anchorBarId: barIds[0], focusBarId: barIds[2] });
  press("ArrowLeft", 1000, modifiers);
  press("ArrowLeft", 1000, modifiers);
  expect(session.cursor).toMatchObject({ barId: barIds[0], beatId: ids[0], at: "on" });
  expect(session.selection).toEqual({ kind: "bars", partId, anchorBarId: barIds[0], focusBarId: barIds[0] });
});

test("a beat range extended bar by bar becomes the range of bars from its bar", () => {
  const { session, press, partId, barIds } = typed([1, 2, 3]);
  press("ArrowRight", 1000, shift);
  press("ArrowRight", 1000, { ctrlKey: true, shiftKey: true });
  expect(session.selection).toEqual({ kind: "bars", partId, anchorBarId: barIds[0], focusBarId: barIds[1] });
});

test("on a Mac, Ctrl+Shift+→ is not a key (macOS takes Ctrl with the arrows); on Windows and Linux, Option's Alt+Shift+→ is not either", () => {
  const mac = typed([1, 2], 3, "mac");
  expect(mac.press("ArrowRight", 1000, { ctrlKey: true, shiftKey: true })).toBe(false);
  expect(mac.session.selection).toBeNull();
  const other = typed([1, 2]);
  expect(other.press("ArrowRight", 1000, { altKey: true, shiftKey: true })).toBe(false);
  expect(other.session.selection).toBeNull();
});

/** The same score with a second part whose first two bars each hold a beat, and how to read that part. */
function withAnotherPart(on: ReturnType<typeof typed>) {
  const otherId = addPart(on.doc, { name: "Bass", kind: "fretted", tuning: [43, 38, 33, 28] });
  for (const barId of on.barIds.slice(0, 2)) setFret(on.doc, cursorAt(on.doc, otherId, barId, 1), 3);
  const other = () => docToJson(on.doc).parts[1]!.content;
  return { other, before: other() };
}

const undoKeys = { other: { ctrlKey: true }, mac: { metaKey: true } } as const;

test.each(["other", "mac"] as const)("on %s, Delete on a beat range makes its beats rests in one undo step, and leaves the other parts alone", (platform) => {
  const on = typed([1, 2, 3, 4], 3, platform);
  const { other, before } = withAnotherPart(on);
  const { session, press, beats, ids } = on;
  press("ArrowRight");
  press("ArrowRight", 1000, shift);
  press("ArrowRight", 1000, shift);
  expect(press("Delete")).toBe(true);
  expect(beats().map((beat) => [beat.id, beat.value, beat.notes])).toEqual([
    [ids[0], 4, { s6: { fret: 1 } }],
    [ids[1], 4, {}],
    [ids[2], 4, {}],
    [ids[3], 4, {}],
  ]);
  expect(other()).toEqual(before);
  // The beats are still there: so is the selection.
  expect(session.selection).toMatchObject({ kind: "beats", anchorBeatId: ids[1], focusBeatId: ids[3] });
  expect(press("z", 1000, undoKeys[platform])).toBe(true);
  expect(beats().map((beat) => beat.notes.s6?.fret)).toEqual([1, 2, 3, 4]);
});

test("Delete again, on a beat range of rests, removes the beats: the cursor goes onto the one that takes their place", () => {
  const { session, press, beats, ids } = typed([1, 2, 3, 4]);
  press("ArrowRight");
  press("ArrowRight", 1000, shift);
  press("Delete");
  press("Delete");
  expect(beats().map((beat) => beat.id)).toEqual([ids[0], ids[3]]);
  expect(session.cursor).toMatchObject({ beatId: ids[3], at: "on" });
  expect(session.selection).toBeNull();
  // One step each: the beats come back as rests, then with their notes.
  press("z", 1000, { ctrlKey: true });
  expect(beats().map((beat) => beat.notes.s6?.fret ?? null)).toEqual([1, null, null, 4]);
  press("z", 1000, { ctrlKey: true });
  expect(beats().map((beat) => beat.notes.s6?.fret)).toEqual([1, 2, 3, 4]);
});

test("removed at the end of the voice, the beats leave the cursor in the append slot after the new last beat", () => {
  const { session, press, beats, ids } = typed([1, 2, 3]);
  press("ArrowRight");
  press("ArrowRight", 1000, shift);
  press("Delete");
  press("Delete");
  expect(beats().map((beat) => beat.id)).toEqual([ids[0]]);
  expect(session.cursor).toMatchObject({ beatId: ids[0], at: "after" });
});

test.each(["other", "mac"] as const)("on %s, Delete on a bar range empties every voice of the part in those bars in one undo step, and leaves the other parts alone", (platform) => {
  const on = typed([1, 2, 3, 4], 3, platform);
  const { other, before } = withAnotherPart(on);
  const { doc, session, press, beats, barIds, partId } = on;
  // A beat in the second voice of the first bar, and one in the second bar.
  setFret(doc, { ...cursorAt(doc, partId, barIds[0]!, 2), voice: "0:1", beatId: null, at: "after" }, 5);
  setFret(doc, cursorAt(doc, partId, barIds[1]!, 2), 6);
  const nav = platform === "mac" ? { altKey: true, shiftKey: true } : { ctrlKey: true, shiftKey: true };
  press("ArrowRight", 1000, nav);
  expect(session.selection).toMatchObject({ kind: "bars", anchorBarId: barIds[0], focusBarId: barIds[1] });
  expect(press("Delete")).toBe(true);
  const content = () => docToJson(doc).parts[0]!.content;
  for (const barId of barIds.slice(0, 2)) expect(Object.values(content()[barId]!).flat()).toEqual([]);
  expect(other()).toEqual(before);
  expect(session.cursor).toMatchObject({ barId: barIds[1], beatId: null, at: "after" });
  expect(session.selection).toMatchObject({ kind: "bars", anchorBarId: barIds[0], focusBarId: barIds[1] });
  expect(press("z", 1000, undoKeys[platform])).toBe(true);
  expect(beats().map((beat) => beat.notes.s6?.fret)).toEqual([1, 2, 3, 4]);
  expect(content()[barIds[0]!]!["0:1"]!.map((beat) => beat.notes)).toEqual([{ s2: { fret: 5 } }]);
  expect(content()[barIds[1]!]!["0:0"]!.map((beat) => beat.notes)).toEqual([{ s2: { fret: 6 } }]);
});

test("while read-only, a Viewer selects, but Delete on the selection changes nothing", () => {
  const { doc, beats, barIds, partId, session: writer } = typed([1, 2]);
  writer.destroy();
  const session = createEditorSession(doc, { platform: "other", cursor: cursorAt(doc, partId, barIds[0]!, 6), readOnly: true });
  const before = beats();
  expect(session.press(keyOf("ArrowRight", shift))).toBe(true);
  expect(session.selection).toMatchObject({ kind: "beats" });
  expect(session.press(keyOf("Delete"))).toBe(true);
  expect(beats()).toEqual(before);
  expect(session.selection).toMatchObject({ kind: "beats" });
});

test("when another member removes a beat the selection ends on, the selection ends and the presence is told", () => {
  const { doc, session, press, ids, partId, barIds } = typed([1, 2, 3]);
  press("ArrowRight", 1000, shift);
  const told: LocalPresence[] = [];
  session.onPresence((presence) => told.push(presence));
  const { other, send } = otherMember(doc);
  other.transact(() => contentOf(partsOf(other).get(partId)!).get(barIds[0]!)!.get("0:0")!.delete(1, 1));
  send();
  expect(session.selection).toBeNull();
  expect(session.cursor).toMatchObject({ beatId: ids[2] });
  expect(told.at(-1)).toEqual({ cursor: session.cursor, selection: null });
});

test("with no selection, Shift with Nav and → at the end of the score selects the cursor's bar", () => {
  const { session, press, partId, barIds } = sessionOn("fretted", 1);
  expect(press("ArrowRight", 1000, { ctrlKey: true, shiftKey: true })).toBe(true);
  expect(session.cursor).toMatchObject({ barId: barIds[0] });
  expect(session.selection).toEqual({ kind: "bars", partId, anchorBarId: barIds[0], focusBarId: barIds[0] });
});
