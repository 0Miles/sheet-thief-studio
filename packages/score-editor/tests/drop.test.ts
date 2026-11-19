// A phrase dropped from the sidebar (docs/spec/phrases.md, section 6; docs/spec/commands.md, 5.7):
// one command of the session, one undo step, refused while read-only; the cursor settles where it
// was, the selection ends.
import { type BarsFragment, COMMON_TIME, createScore, docToJson, STANDARD_GUITAR } from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { createEditorSession, type KeyPlatform } from "../src/index";
import { band, MODIFIERS, PLATFORMS } from "./band";

/** A guitar phrase: each bar four quarters on string 1, of the frets given. */
function guitarPhrase(...bars: number[][]): BarsFragment & { kind: "fretted" } {
  return {
    kind: "fretted",
    tuning: [...STANDARD_GUITAR],
    bars: bars.map((frets) => ({ timeSig: { ...COMMON_TIME }, voices: { "0:0": frets.map((fret) => ({ value: 4 as const, dots: 0 as const, notes: { s1: { fret } } })) } })),
  };
}

/** The frets of the first voice of a bar of a part, beat by beat. */
function fretsIn(doc: Y.Doc, partId: string, barId: string): (number | undefined)[] {
  const part = docToJson(doc).parts.find((each) => each.id === partId)!;
  return (part.content[barId]?.["0:0"] ?? []).map((beat) => Object.values(beat.notes)[0]?.fret);
}

test.each(PLATFORMS)("on %s, a phrase dropped on a bar of a part replaces its bars from there, and one undo brings them back", (platform: KeyPlatform) => {
  const { doc, session, partIds, barIds } = band(platform);
  const before = docToJson(doc);
  const dropped = session.drop({ partId: partIds.guitar, barId: barIds[1]! }, guitarPhrase([1, 2, 3, 4], [5, 6, 7, 8]));
  expect(dropped).toEqual({ barIds: [barIds[1], barIds[2]], hints: [] });
  expect(fretsIn(doc, partIds.guitar, barIds[1]!)).toEqual([1, 2, 3, 4]);
  expect(fretsIn(doc, partIds.guitar, barIds[2]!)).toEqual([5, 6, 7, 8]);

  expect(session.press({ code: "KeyZ", ...MODIFIERS[platform].mod })).toBe(true);
  expect(docToJson(doc)).toEqual(before);
});

test("the cursor settles where it was, on a beat that is there after its own was replaced; a selection ends", () => {
  const { doc, session, partIds, barIds } = band();
  session.press({ code: "ArrowRight", shiftKey: true });
  expect(session.selection).not.toBeNull();
  const at = session.cursor!;
  session.drop({ partId: partIds.guitar, barId: barIds[0]! }, guitarPhrase([1, 2, 3, 4]));
  expect(session.selection).toBeNull();
  expect(session.cursor).toMatchObject({ partId: partIds.guitar, barId: at.barId, voice: at.voice });
  const beatIds = docToJson(doc).parts[0]!.content[barIds[0]!]!["0:0"]!.map((beat) => beat.id);
  expect(session.cursor!.beatId).not.toBe(at.beatId);
  expect(session.cursor!.at === "after" || beatIds.includes(session.cursor!.beatId!)).toBe(true);
});

test("a drop on a part of another kind, or past the strings of the part, is refused, telling why, and nothing changes", () => {
  const { doc, session, partIds, barIds } = band();
  const before = docToJson(doc);
  expect(session.drop({ partId: partIds.drums, barId: barIds[0]! }, guitarPhrase([1, 2, 3, 4]))).toBe("otherKind");
  const sevenStrings: BarsFragment = { kind: "fretted", tuning: [...STANDARD_GUITAR, 35], bars: [{ timeSig: { ...COMMON_TIME }, voices: { "0:0": [{ value: 1, dots: 0, notes: { s7: { fret: 0 } } }] } }] };
  expect(session.drop({ partId: partIds.guitar, barId: barIds[0]! }, sevenStrings)).toBe("tooManyStrings");
  expect(docToJson(doc)).toEqual(before);
});

test("the hints of a drop come back for the page to tell: another tuning, bars appended", () => {
  const { session, partIds, barIds } = band();
  const dropped = session.drop({ partId: partIds.guitar, barId: barIds[2]! }, { ...guitarPhrase([1, 2, 3, 4], [5, 6, 7, 8]), tuning: [64, 59, 55, 50, 45, 38] });
  expect(dropped).toMatchObject({ hints: ["tuningDiffers", "barsAppended"] });
});

test("read-only, nothing is dropped, and the member is told the first time", () => {
  const { doc } = band();
  const json = docToJson(doc);
  const session = createEditorSession(doc, { platform: "other", readOnly: true, cursor: null });
  session.moveTo({ partId: json.parts[0]!.id, barId: json.bars[0]!.id, voice: "0:0", beatId: null, at: "after", line: 1 });
  const refused: number[] = [];
  session.onRefused(() => refused.push(1));
  expect(session.drop({ partId: json.parts[0]!.id, barId: json.bars[0]!.id }, guitarPhrase([1, 2, 3, 4]))).toBeNull();
  expect(docToJson(doc)).toEqual(json);
  expect(refused).toEqual([1]);
});

test("a session without a cursor drops nothing", () => {
  const doc = new Y.Doc();
  createScore(doc, "Empty");
  const session = createEditorSession(doc, { platform: "other", cursorless: true });
  expect(session.drop({ partId: "none", barId: "none" }, guitarPhrase([1, 2, 3, 4]))).toBeNull();
});
