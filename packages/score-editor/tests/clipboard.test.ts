// Copy, cut and paste (docs/spec/commands.md, 5.6; docs/spec/phrases.md, section 2): what the
// session gives the shell to write, and what it does with what the shell read, as commands.
import { clipboardText, createScore, cursorAt, docToJson, fragmentOfClipboard, insertBars, addPart } from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { createEditorSession } from "../src/index";
import { sessionOn, undoEach } from "./support";

/** A guitar whose first bar holds quarters of frets 1, 2, 3 on string 6, the cursor on the first and the three selected. */
function threeSelected(readOnly = false) {
  const typed = sessionOn("fretted", 3);
  const { press } = typed;
  for (const [index, fret] of [1, 2, 3].entries()) {
    if (index > 0) press("ArrowRight");
    press(String(fret));
  }
  press("Home");
  press("ArrowRight", 1000, { shiftKey: true });
  press("ArrowRight", 1000, { shiftKey: true });
  if (!readOnly) return typed;
  const { doc, session: writer, partId, barIds } = typed;
  writer.destroy();
  // A Viewer's session, which selects the same three beats.
  const session = createEditorSession(doc, { platform: "other", cursor: cursorAt(doc, partId, barIds[0]!, 6), readOnly: true });
  session.press({ code: "ArrowRight", shiftKey: true });
  session.press({ code: "ArrowRight", shiftKey: true });
  return { ...typed, session };
}

const frets = (beats: { notes: Record<string, { fret?: number }> }[]) => beats.map((beat) => beat.notes.s6?.fret);

test("a copy of a range of beats is the clipboard's text of those beats; without a selection, nothing", () => {
  const { session, press } = threeSelected();
  expect(session.selection?.kind).toBe("beats");
  const text = session.copy();
  expect(fragmentOfClipboard(text!)).toEqual({ kind: "fretted", tuning: [64, 59, 55, 50, 45, 40], beats: [1, 2, 3].map((fret) => ({ value: 4, dots: 0, notes: { s6: { fret } } })) });
  // Copying changes nothing, the selection either.
  expect(session.selection?.kind).toBe("beats");
  press("Escape");
  expect(session.copy()).toBeNull();
});

test("cut copies and clears the beats, pasting elsewhere inserts them, each one undo step", () => {
  const { session, press, beats, doc, partId, barIds } = threeSelected();
  const all = (bar: number) => docToJson(doc).parts[0]!.content[barIds[bar]!]!["0:0"]!;
  const typed = beats();
  const text = session.cut();
  expect(fragmentOfClipboard(text!)).toMatchObject({ beats: [{ notes: { s6: { fret: 1 } } }, {}, {}] });
  // The notes go, the beats stay as rests; so does the selection.
  expect(frets(beats())).toEqual([undefined, undefined, undefined]);
  expect(session.selection?.kind).toBe("beats");

  session.moveTo(cursorAt(doc, partId, barIds[1]!, 6));
  expect(session.paste(text!)).toEqual({ hints: [] });
  expect(frets(all(1))).toEqual([1, 2, 3]);
  expect(all(1).map((beat) => beat.id)).not.toContain(typed[0]!.id);
  expect(session.cursor).toMatchObject({ barId: barIds[1], beatId: all(1)[2]!.id, at: "on" });
  expect(session.selection).toBeNull();

  undoEach(press, "other", () => [frets(all(0)), frets(all(1))], [
    [[undefined, undefined, undefined], []],
    [[1, 2, 3], []],
  ]);
});

test("bars copied and pasted replace the bars from the cursor's, one undo step", () => {
  const { session, press, doc, partId, barIds } = threeSelected();
  const all = (bar: number) => docToJson(doc).parts[0]!.content[barIds[bar]!]!["0:0"]!;
  press("Home");
  press("ArrowRight", 1000, { shiftKey: true, ctrlKey: true });
  expect(session.selection).toMatchObject({ kind: "bars", anchorBarId: barIds[0], focusBarId: barIds[1] });
  const text = session.copy()!;
  session.moveTo(cursorAt(doc, partId, barIds[2]!, 6));
  // Two bars from the last: one is appended.
  expect(session.paste(text)).toEqual({ hints: ["barsAppended"] });
  expect(docToJson(doc).bars).toHaveLength(4);
  expect(frets(all(2))).toEqual([1, 2, 3]);
  expect(session.cursor).toMatchObject({ barId: barIds[2], beatId: all(2)[0]!.id, at: "on" });
  press("z", 1000, { ctrlKey: true });
  expect(docToJson(doc).bars).toHaveLength(3);
  expect(all(2)).toEqual([]);
});

test("what is not a fragment, or one of another kind, is not pasted, and the member is told why", () => {
  const doc = new Y.Doc();
  createScore(doc, "Band");
  const [bar] = insertBars(doc, { after: null, count: 1 });
  const drums = addPart(doc, { name: "Drums", kind: "percussion" });
  const session = createEditorSession(doc, { platform: "other", cursor: cursorAt(doc, drums, bar!) });
  let transactions = 0;
  doc.on("afterTransaction", () => (transactions += 1));
  expect(session.paste("hello")).toBe("nothing");
  expect(session.paste(clipboardText({ kind: "fretted", tuning: [64, 59, 55, 50, 45, 40], beats: [{ value: 4, dots: 0, notes: { s1: { fret: 1 } } }] }))).toBe("otherKind");
  expect(transactions).toBe(0);
});

test("read-only, a copy is made, but a cut or a paste changes nothing and is refused once", () => {
  const { session, doc } = threeSelected(true);
  const before = docToJson(doc);
  let refusals = 0;
  session.onRefused(() => (refusals += 1));
  expect(session.selection?.kind).toBe("beats");
  const text = session.copy();
  expect(fragmentOfClipboard(text!)).toMatchObject({ beats: [{}, {}, {}] });
  let transactions = 0;
  doc.on("afterTransaction", () => (transactions += 1));
  expect(session.cut()).toBeNull();
  expect(session.paste(text!)).toBeNull();
  expect(transactions).toBe(0);
  expect(docToJson(doc)).toEqual(before);
  expect(refusals).toBe(1);
});
