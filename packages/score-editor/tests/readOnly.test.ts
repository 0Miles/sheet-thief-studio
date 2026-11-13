// The read-only edit view (docs/spec/views.md, section 4): the cursor moves, the score does not change.
import { cursorAt, docToJson, setFret } from "@studio/score-model";
import { expect, test } from "vitest";

import { createEditorSession } from "../src/index";
import { keyOf, typingOn } from "./support";

/** Every key that changes a fretted part, with its modifiers. */
const CHANGING_KEYS: [string, Parameters<typeof keyOf>[1]?][] = [
  ...[..."0123456789"].map((digit): [string] => [digit]),
  ["Insert"],
  ["+"],
  ["-"],
  ["Delete"],
  ["z", { ctrlKey: true }],
  ["z", { metaKey: true }],
  ["y", { ctrlKey: true }],
  ["z", { ctrlKey: true, shiftKey: true }],
];

/** Two beats typed by a member who could, then a read-only session on the same score. */
function readOnlyScore() {
  const { doc, press, partId, barIds, session: typing } = typingOn();
  press("5");
  press("Insert");
  press("7");
  typing.destroy();
  const session = createEditorSession(doc, { cursor: cursorAt(doc, partId, barIds[0]!, 6), readOnly: true });
  return { doc, session, partId, barIds };
}

test("while read-only, no key changes the score, and the refusal is told only the first time", () => {
  const { doc, session } = readOnlyScore();
  // Something this page did that undo could take back, if it were allowed to.
  setFret(doc, session.cursor!, 9);
  const before = docToJson(doc);
  let transactions = 0;
  doc.on("afterTransaction", () => (transactions += 1));
  let refusals = 0;
  session.onRefused(() => (refusals += 1));

  for (const [key, modifiers] of CHANGING_KEYS) expect(session.press(keyOf(key, modifiers))).toBe(true);
  for (const [key, modifiers] of CHANGING_KEYS) session.press(keyOf(key, modifiers));

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

