// Undo and redo (docs/spec/commands.md, section 8): every combination of each platform, and every
// command, the title of the score among them, one undo step each.
import {
  addPart,
  appendBar,
  type BeatChange,
  changeBeatAt,
  changeBeatsOnSelection,
  clearNotes,
  type Cursor,
  cursorAt,
  deleteBarsAt,
  deleteBeat,
  deleteNote,
  deleteSelection,
  docToJson,
  dotCycle,
  durationStep,
  dynamicCycle,
  insertBarAt,
  insertBars,
  insertBeat,
  type Selection,
  setDuration,
  setFret,
  setNote,
  setTempo,
  setText,
  setTimeSig,
  setTitle,
  slapPopCycle,
  strokeCycle,
  techniqueToggle,
  toggleAt,
  toggleOnSelection,
  tripletToggle,
} from "@studio/score-model";
import { expect, test } from "vitest";
import type * as Y from "yjs";

import { band } from "./band";
import { otherMember } from "./support";

const UNDO = {
  other: [{ code: "KeyZ", ctrlKey: true }],
  mac: [{ code: "KeyZ", metaKey: true }],
} as const;
const REDO = {
  other: [
    { code: "KeyY", ctrlKey: true },
    { code: "KeyZ", ctrlKey: true, shiftKey: true },
  ],
  mac: [{ code: "KeyZ", metaKey: true, shiftKey: true }],
} as const;

test.each([
  ["Windows and Linux", "other", UNDO.other, REDO.other],
  ["a Mac", "mac", UNDO.mac, REDO.mac],
] as const)("on %s, each combination of undo and of redo takes back and does again the member's last command", (_, platform, undoKeys, redoKeys) => {
  for (const undoKey of undoKeys) {
    for (const redoKey of redoKeys) {
      const { session, press, beats } = band(platform);
      press("r", { shiftKey: true });
      expect(beats("guitar", 0)[0]!.notes).toEqual({});
      expect(session.press(undoKey)).toBe(true);
      expect(beats("guitar", 0)[0]!.notes).toEqual({ s1: { fret: 5 } });
      expect(session.press(redoKey)).toBe(true);
      expect(beats("guitar", 0)[0]!.notes).toEqual({});
    }
  }
});

test.each([
  ["a Mac", "mac", [{ code: "KeyZ", ctrlKey: true }, { code: "KeyY", metaKey: true }, { code: "KeyY", ctrlKey: true }, { code: "KeyZ", ctrlKey: true, shiftKey: true }]],
  ["Windows and Linux", "other", [{ code: "KeyZ", metaKey: true }, { code: "KeyZ", ctrlKey: true, altKey: true }, { code: "KeyY", ctrlKey: true, shiftKey: true }, { code: "KeyZ", metaKey: true, shiftKey: true }]],
] as const)("on %s, the other platform's undo and redo, and the combinations with one more modifier, do nothing", (_, platform, keys) => {
  const { session, press, beats } = band(platform);
  press("r", { shiftKey: true });
  for (const key of keys) expect(session.press(key)).toBe(false);
  expect(beats("guitar", 0)[0]!.notes).toEqual({});
  // Undone, there is nothing a stray redo could do again.
  session.press(UNDO[platform][0]);
  for (const key of keys) expect(session.press(key)).toBe(false);
  expect(beats("guitar", 0)[0]!.notes).toEqual({ s1: { fret: 5 } });
});

/** A command of score-model, run as the member would (with origin LOCAL), at the cursor of the band score. */
type Command = (doc: Y.Doc, at: { cursor: Cursor; beats: Selection; bars: Selection; partId: string; barIds: string[] }) => unknown;

const COMMANDS: [string, Command][] = [
  ["setFret", (doc, { cursor }) => setFret(doc, cursor, 7)],
  ["setNote", (doc, { cursor }) => setNote(doc, cursor, "s2", { fret: 3 })],
  ["insertBeat", (doc, { cursor }) => insertBeat(doc, cursor)],
  ["deleteNote", (doc, { cursor }) => deleteNote(doc, cursor)],
  ["deleteBeat", (doc, { cursor }) => deleteBeat(doc, cursor)],
  ["deleteSelection on beats", (doc, { cursor, beats }) => deleteSelection(doc, beats, cursor)],
  ["deleteSelection on bars", (doc, { cursor, bars }) => deleteSelection(doc, bars, cursor)],
  ["setDuration", (doc, { cursor }) => setDuration(doc, cursor, { value: 8, dots: 1 })],
  ...([durationStep(1), durationStep(-1), dotCycle, tripletToggle, clearNotes, strokeCycle, slapPopCycle, dynamicCycle] as BeatChange<unknown>[]).map((change, index): [string, Command] => [`changeBeatAt #${index}`, (doc, { cursor }) => changeBeatAt(doc, cursor, change)]),
  ...([durationStep(1), dotCycle, tripletToggle, clearNotes, dynamicCycle] as BeatChange<unknown>[]).map((change, index): [string, Command] => [`changeBeatsOnSelection #${index}`, (doc, { cursor, bars }) => changeBeatsOnSelection(doc, bars, cursor, change)]),
  ["setText", (doc, { cursor }) => setText(doc, cursor, "Am7")],
  ["toggleAt", (doc, { cursor }) => toggleAt(doc, cursor, "s1", techniqueToggle("vibrato"))],
  ["toggleOnSelection", (doc, { cursor, beats }) => toggleOnSelection(doc, beats, cursor, techniqueToggle("accent"))],
  ["insertBars", (doc, { barIds }) => insertBars(doc, { after: barIds[0]!, count: 2 })],
  ["insertBarAt before", (doc, { cursor }) => insertBarAt(doc, cursor, "before")],
  ["insertBarAt after", (doc, { cursor }) => insertBarAt(doc, cursor, "after")],
  ["appendBar", (doc, { cursor }) => appendBar(doc, cursor)],
  ["deleteBarsAt", (doc, { cursor }) => deleteBarsAt(doc, cursor, null)],
  ["deleteBarsAt on bars", (doc, { cursor, bars, barIds }) => deleteBarsAt(doc, cursor, { ...bars, kind: "bars", anchorBarId: barIds[0]!, focusBarId: barIds[1]! })],
  ["setTimeSig", (doc, { cursor }) => setTimeSig(doc, cursor, null, { numerator: 7, denominator: 8 })],
  ["setTimeSig on bars", (doc, { cursor, bars }) => setTimeSig(doc, cursor, bars, { numerator: 7, denominator: 8 })],
  ["setTempo", (doc, { cursor }) => setTempo(doc, cursor, 72)],
  ["addPart", (doc) => addPart(doc, { name: "Bass", kind: "fretted", tuning: [43, 38, 33, 28] })],
  ["setTitle", (doc) => setTitle(doc, "新的標題")],
];

test.each(COMMANDS)("%s is undone in one step with Ctrl+Z, and done again with Ctrl+Y", (_, command) => {
  const { doc, session, partIds, barIds } = band();
  const cursor = cursorAt(doc, partIds.guitar, barIds[0]!);
  const beats: Selection = { kind: "beats", partId: partIds.guitar, barId: barIds[0]!, voice: "0:0", anchorBeatId: cursor.beatId!, focusBeatId: cursor.beatId! };
  const bars: Selection = { kind: "bars", partId: partIds.keys, anchorBarId: barIds[0]!, focusBarId: barIds[2]! };
  const before = docToJson(doc);
  command(doc, { cursor, beats, bars, partId: partIds.guitar, barIds });
  const after = docToJson(doc);
  expect(after).not.toEqual(before);
  expect(session.press({ code: "KeyZ", ctrlKey: true })).toBe(true);
  expect(docToJson(doc)).toEqual(before);
  session.press({ code: "KeyY", ctrlKey: true });
  expect(docToJson(doc)).toEqual(after);
});

test.each(["other", "mac"] as const)("on %s, a change of the title is undone and done again, and so is a change of the title right after a key", (platform) => {
  const { doc, session, press, beats } = band(platform);
  setTitle(doc, "第一版");
  press("r", { shiftKey: true });
  setTitle(doc, "第二版");
  const title = () => docToJson(doc).title;
  session.press(UNDO[platform][0]);
  expect(title()).toBe("第一版");
  expect(beats("guitar", 0)[0]!.notes).toEqual({});
  session.press(UNDO[platform][0]);
  session.press(UNDO[platform][0]);
  expect(title()).toBe("Band");
  session.press(REDO[platform][0]);
  expect(title()).toBe("第一版");
});

test("undo takes back only this member's changes: the title another member gave stays", () => {
  const { doc, session } = band();
  setTitle(doc, "我的");
  const { other, send } = otherMember(doc);
  setTitle(other, "別人的");
  send();
  session.press({ code: "KeyZ", ctrlKey: true });
  expect(docToJson(doc).title).toBe("別人的");
});
