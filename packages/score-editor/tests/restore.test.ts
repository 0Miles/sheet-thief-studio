// Restoring a version from the session (docs/spec/collab.md, 8.5; docs/spec/commands.md, section
// 8): one undo step, refused while read-only, the cursor kept where the version has its place.
import { cursorAt, docToJson, SCHEMA_VERSION, type ScoreJSON, setTitle } from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { createEditorSession, type KeyPlatform } from "../src/index";
import { band, MODIFIERS, PLATFORMS } from "./band";

test.each(PLATFORMS)("on %s, a restored version is the score, ids and all, until one undo brings back the score before it; redo restores it again", (platform: KeyPlatform) => {
  const { doc, session } = band(platform);
  const version = docToJson(doc);
  setTitle(doc, "改過的");
  session.press({ code: "Digit7" });
  const before = docToJson(doc);
  expect(before).not.toEqual(version);

  expect(session.replaceScore(version)).toBe(true);
  expect(docToJson(doc)).toEqual(version);
  expect(session.press({ code: "KeyZ", ...MODIFIERS[platform].mod })).toBe(true);
  expect(docToJson(doc)).toEqual(before);
  session.press(platform === "mac" ? { code: "KeyZ", metaKey: true, shiftKey: true } : { code: "KeyY", ctrlKey: true });
  expect(docToJson(doc)).toEqual(version);
});

test("the cursor stays where the version has its place; where it has none, it goes to the start of the score", () => {
  const { doc, session, partIds, barIds } = band();
  const at = cursorAt(doc, partIds.keys, barIds[2]!);
  session.moveTo(at);
  const version = docToJson(doc);
  expect(session.replaceScore(version)).toBe(true);
  expect(session.cursor).toMatchObject({ partId: partIds.keys, barId: barIds[2] });

  const elsewhere: ScoreJSON = { ...version, bars: [{ id: "only", timeSig: { numerator: 4, denominator: 4 } }], parts: version.parts.slice(0, 1).map((part) => ({ ...part, content: {} })) };
  expect(session.replaceScore(elsewhere)).toBe(true);
  expect(session.cursor).toMatchObject({ partId: partIds.guitar, barId: "only" });
});

test("read-only, or with a version this code cannot read, nothing is restored", () => {
  const { doc } = band();
  const version = docToJson(doc);
  setTitle(doc, "目前的");
  const now = docToJson(doc);
  const reader = createEditorSession(doc, { platform: "other", readOnly: true });
  const refused: string[] = [];
  reader.onRefused(() => refused.push("readOnly"));
  expect(reader.replaceScore(version)).toBe(false);
  expect(refused).toEqual(["readOnly"]);

  const writer = createEditorSession(doc, { platform: "other" });
  expect(writer.replaceScore({ ...version, schemaVersion: SCHEMA_VERSION + 1 })).toBe(false);
  expect(writer.replaceScore({ title: "不是團譜" })).toBe(false);
  expect(docToJson(doc)).toEqual(now);
});

test("a restore reaches another member's copy as the version", () => {
  const { doc, session } = band();
  const version = docToJson(doc);
  setTitle(doc, "改過的");
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  doc.on("update", (update: Uint8Array) => Y.applyUpdate(other, update));
  session.replaceScore(version);
  expect(docToJson(other)).toEqual(version);
});
