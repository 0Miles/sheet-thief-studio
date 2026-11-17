// The settings of the parts and of the score, run from the panel of the parts and the title bar
// (docs/spec/commands.md, section 7): each one undo step on both platforms, refused while
// read-only, with or without a cursor; a cursor in a part another member deletes goes to the start
// of the score.
import { addPart, createScore, cursorAt, docToJson, insertBars, MAX_NON_PERCUSSION_PARTS, partsOf, startOfScore, tuningFor } from "@studio/score-model";
import { describe, expect, test } from "vitest";
import * as Y from "yjs";

import { createEditorSession, type EditorSession, type SessionHint } from "../src/index";
import { band, PLATFORMS } from "./band";
import { otherMember } from "./support";

const UNDO = { other: { code: "KeyZ", ctrlKey: true }, mac: { code: "KeyZ", metaKey: true } } as const;
const REDO = { other: { code: "KeyY", ctrlKey: true }, mac: { code: "KeyZ", metaKey: true, shiftKey: true } } as const;

type Setting = [name: string, run: (session: EditorSession, parts: ReturnType<typeof band>["partIds"]) => boolean];

const SETTINGS: Setting[] = [
  ["addPart", (session) => session.addPart("bass5", tuningFor("drop", 5))],
  ["deletePart", (session, { keys }) => session.deletePart(keys)],
  ["movePart", (session, { drums }) => session.movePart(drums, null)],
  ["setPartName", (session, { guitar }) => session.setPartName(guitar, "主奏吉他")],
  ["setTuning", (session, { guitar }) => session.setTuning(guitar, tuningFor("halfDown", 6))],
  ["setCapo", (session, { guitar }) => session.setCapo(guitar, 4)],
  ["setProgram", (session, { keys }) => session.setProgram(keys, 5)],
  ["setClef", (session, { keys }) => session.setClef(keys, 0, "treble-8vb")],
  ["setTitle", (session) => session.setTitle("新的標題")],
  ["setArtist", (session) => session.setArtist("樂團")],
];

describe.each(PLATFORMS)("on %s", (platform) => {
  test.each(SETTINGS)("%s is one undo step, done again with redo", (_, run) => {
    const { doc, session, partIds } = band(platform);
    const before = docToJson(doc);
    expect(run(session, partIds)).toBe(true);
    const after = docToJson(doc);
    expect(after).not.toEqual(before);
    expect(session.press(UNDO[platform])).toBe(true);
    expect(docToJson(doc)).toEqual(before);
    session.press(REDO[platform]);
    expect(docToJson(doc)).toEqual(after);
  });
});

test.each(SETTINGS)("%s is refused while read-only, the member told once", (_, run) => {
  const { doc, partIds } = band();
  const session = createEditorSession(doc, { platform: "other", readOnly: true });
  let told = 0;
  session.onRefused(() => (told += 1));
  const before = docToJson(doc);
  expect(run(session, partIds)).toBe(false);
  expect(run(session, partIds)).toBe(false);
  expect(docToJson(doc)).toEqual(before);
  expect(told).toBe(1);
});

test("the settings need no cursor, and a selection ends after them", () => {
  const { doc } = band();
  const session = createEditorSession(doc, { platform: "other" });
  expect(session.cursor).toBeNull();
  expect(session.setTitle("沒有游標")).toBe(true);
  expect(session.addPart("drums")).toBe(true);
  expect(docToJson(doc).title).toBe("沒有游標");
  expect(session.cursor).toBeNull();

  const typing = band();
  typing.press("ArrowRight", { shiftKey: true });
  expect(typing.session.selection).not.toBeNull();
  // A value out of range does nothing: the selection stays.
  expect(typing.session.setCapo(typing.partIds.guitar, 25)).toBe(false);
  expect(typing.session.selection).not.toBeNull();
  expect(typing.session.setCapo(typing.partIds.guitar, 2)).toBe(true);
  expect(typing.session.selection).toBeNull();
});

test("a part past the limits, and the last part deleted, are refused, and the member is told why", () => {
  const doc = new Y.Doc();
  createScore(doc, "Full");
  const [barId] = insertBars(doc, { after: null, count: 1 });
  const first = addPart(doc, { name: "吉他 1", kind: "fretted" });
  const session = createEditorSession(doc, { platform: "other", cursor: cursorAt(doc, first, barId!) });
  const hints: SessionHint[] = [];
  session.onHint((hint) => hints.push(hint));
  expect(session.deletePart(first)).toBe(false);
  expect(hints).toEqual(["lastPart"]);
  for (let count = 1; count < MAX_NON_PERCUSSION_PARTS; count++) expect(session.addPart("guitar6")).toBe(true);
  expect(session.addPart("vocals")).toBe(false);
  expect(hints).toEqual(["lastPart", "tooManyParts"]);
  expect(docToJson(doc).parts).toHaveLength(MAX_NON_PERCUSSION_PARTS);
  expect(docToJson(doc).parts.map((part) => part.name).slice(0, 3)).toEqual(["吉他 1", "吉他 2", "吉他 3"]);
  // A value out of range is no refusal to tell of.
  expect(session.setCapo(first, 99)).toBe(false);
  expect(hints).toHaveLength(2);
});

test("deleting the part one's cursor is in takes the cursor to the start of the score; undo brings the part back, the cursor staying", () => {
  const { doc, session, partIds, barIds, goTo } = band();
  goTo("guitar", 2);
  expect(session.deletePart(partIds.guitar)).toBe(true);
  expect(session.cursor).toEqual(cursorAt(doc, partIds.keys, barIds[0]!));
  session.press(UNDO.other);
  expect(docToJson(doc).parts.map((part) => part.id)).toEqual([partIds.guitar, partIds.keys, partIds.drums]);
  expect(session.cursor?.partId).toBe(partIds.keys);
});

test("another member deleting the part the cursor is in: the cursor goes to the start of the score, on the line it had there", () => {
  const { doc, session, partIds, barIds, goTo, press } = band();
  // The keyboard's line, as the member left it.
  goTo("keys", 0, "0:0", 0, 4);
  press("ArrowDown");
  const keysLine = session.cursor!.line;
  goTo("guitar", 1, "0:0", -1);
  const { other, send } = otherMember(doc);
  partsOf(other).delete(partIds.guitar);
  send();
  expect(session.cursor).toEqual(cursorAt(doc, partIds.keys, barIds[0]!, keysLine));
  expect(session.cursor).toEqual(startOfScore(doc, new Map([[partIds.keys, keysLine]])));
});

test("two members deleting the same part at once, one with the cursor in it: both end with the same score, the cursor at the start of the score", () => {
  const { doc, session, partIds, barIds, goTo } = band();
  goTo("keys", 2);
  const { other, send } = otherMember(doc);
  const theirs = createEditorSession(other, { platform: "other" });
  expect(theirs.deletePart(partIds.keys)).toBe(true);
  expect(session.deletePart(partIds.keys)).toBe(true);
  send();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(other)));
  expect(docToJson(doc).parts.map((part) => part.id)).toEqual([partIds.guitar, partIds.drums]);
  expect(docToJson(other)).toEqual(docToJson(doc));
  expect(session.cursor).toEqual(cursorAt(doc, partIds.guitar, barIds[0]!));
});
