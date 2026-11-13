// The read-only edit view (docs/spec/views.md, section 4): the cursor moves, the score does not change.
import { cursorAt, docToJson, type NoteJSON, type PartKind, setNote } from "@studio/score-model";
import { expect, test } from "vitest";

import { createEditorSession } from "../src/index";
import { keyOf, sessionOn } from "./support";

type Press = [key: string, modifiers?: Parameters<typeof keyOf>[1]];

/** The keys that change a part of any kind, with their modifiers. */
const CHANGING_KEYS: Press[] = [
  ["Insert"],
  ["+"],
  ["-"],
  ["z", { ctrlKey: true }],
  ["z", { metaKey: true }],
  ["y", { ctrlKey: true }],
  ["z", { ctrlKey: true, shiftKey: true }],
];

/** The keys that change a fretted part only. */
const FRETTED_KEYS: Press[] = [...[..."0123456789"].map((digit): Press => [digit]), ["Delete"]];

/** A note of each kind, by its key. */
const NOTES: Record<PartKind, [key: string, note: NoteJSON]> = { fretted: ["s6", { fret: 9 }], percussion: ["p38", {}], pitched: ["n60", {}] };

/** Two beats entered by a member who could, then a read-only session on the same score. */
function readOnlyScore(kind: PartKind = "fretted") {
  const { doc, press, partId, barIds, session: writer } = sessionOn(kind);
  press("Insert");
  press("Insert");
  if (kind === "fretted") press("7");
  writer.destroy();
  const session = createEditorSession(doc, { cursor: cursorAt(doc, partId, barIds[0]!, 6), readOnly: true });
  return { doc, session, barIds };
}

test.each(["fretted", "percussion", "pitched"] as const)("while read-only, no key changes a %s part, and the refusal is told only the first time", (kind) => {
  const { doc, session, barIds } = readOnlyScore(kind);
  // Something this page did that undo could take back, if it were allowed to.
  setNote(doc, session.cursor!, ...NOTES[kind]);
  const before = docToJson(doc);
  expect(Object.keys(before.parts[0]!.content[barIds[0]!]!["0:0"]![0]!.notes)).toContain(NOTES[kind][0]);
  let transactions = 0;
  doc.on("afterTransaction", () => (transactions += 1));
  let refusals = 0;
  session.onRefused(() => (refusals += 1));

  const keys = kind === "fretted" ? [...CHANGING_KEYS, ...FRETTED_KEYS] : CHANGING_KEYS;
  for (const [key, modifiers] of keys) expect(session.press(keyOf(key, modifiers))).toBe(true);
  for (const [key, modifiers] of keys) session.press(keyOf(key, modifiers));

  expect(transactions).toBe(0);
  expect(docToJson(doc)).toEqual(before);
  expect(refusals).toBe(1);
});

test("while read-only, the cursor moves as usual", () => {
  const { doc, session, barIds } = readOnlyScore();
  const beatIds = docToJson(doc).parts[0]!.content[barIds[0]!]!["0:0"]!.map((beat) => beat.id);
  let refusals = 0;
  session.onRefused(() => (refusals += 1));
  expect(session.press(keyOf("ArrowRight"))).toBe(true);
  expect(session.press(keyOf("ArrowUp"))).toBe(true);
  expect(session.cursor).toMatchObject({ beatId: beatIds[1], line: 5 });
  session.press(keyOf("ArrowRight"));
  expect(session.cursor).toMatchObject({ barId: barIds[1], beatId: null });
  expect(refusals).toBe(0);
});
