// The fields of a beat a key sets (docs/spec/commands.md, 5.4 and 5.5): stroke, slap or pop,
// dynamic and text, at the cursor and over a selection.
import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  addPart,
  changeBeatAt,
  changeBeatsOnSelection,
  contentOf,
  createScore,
  type Cursor,
  cursorAt,
  docToJson,
  dynamicCycle,
  insertBars,
  type PartKind,
  partsOf,
  readScore,
  type Selection,
  setFret,
  setNote,
  setText,
  slapPopCycle,
  strokeCycle,
} from "../src/index";
import { appendBeat, transactionsOf, undoOf } from "./support";

/** A part over two bars; the first holds `count` quarters, each with a note (a fret on string 2 for a guitar). */
function part(kind: PartKind = "fretted", count = 3) {
  const doc = new Y.Doc();
  createScore(doc, "Demo");
  const barIds = insertBars(doc, { after: null, count: 2 });
  const partId = addPart(doc, { name: "Part", kind });
  let cursor: Cursor = cursorAt(doc, partId, barIds[0]!, 2);
  const ids = Array.from({ length: count }, (_, index) => {
    cursor = appendBeat(doc, cursor, { value: 4 });
    if (kind === "fretted") setFret(doc, cursor, index + 1);
    else setNote(doc, cursor, kind === "pitched" ? "n60" : "p38", {});
    return cursor.beatId!;
  });
  const beats = (bar = 0) => docToJson(doc).parts[0]!.content[barIds[bar]!]!["0:0"]!;
  const on = (index: number): Cursor => ({ ...cursorAt(doc, partId, barIds[0]!, 2), beatId: ids[index]!, at: "on" });
  const range = (first: number, last: number): Selection => ({ kind: "beats", partId, barId: barIds[0]!, voice: "0:0", anchorBeatId: ids[first]!, focusBeatId: ids[last]! });
  const stored = (index: number) => contentOf(partsOf(doc).get(partId)!).get(barIds[0]!)!.get("0:0")!.get(index);
  return { doc, barIds, partId, ids, beats, on, range, stored };
}

test("at the cursor, Shift+U's change strokes its beat down, then up, then not at all, one undo step each", () => {
  const { doc, beats, on } = part();
  const undo = undoOf(doc);
  const strokes = () => beats().map((beat) => beat.stroke ?? null);
  changeBeatAt(doc, on(1), strokeCycle);
  expect(strokes()).toEqual([null, "down", null]);
  changeBeatAt(doc, on(1), strokeCycle);
  expect(strokes()).toEqual([null, "up", null]);
  changeBeatAt(doc, on(1), strokeCycle);
  expect(strokes()).toEqual([null, null, null]);
  expect("stroke" in beats()[1]!).toBe(false);
  undo.undo();
  expect(strokes()).toEqual([null, "up", null]);
  undo.undo();
  undo.undo();
  expect(strokes()).toEqual([null, null, null]);
  // The notes are as they were.
  expect(beats().map((beat) => beat.notes.s2?.fret)).toEqual([1, 2, 3]);
});

test("at the cursor, Shift+J's change slaps its beat, then pops it, then neither, never both, one undo step each", () => {
  const { doc, beats, on } = part();
  const undo = undoOf(doc);
  const states = () => beats().map(({ slap, pop }) => [slap ?? null, pop ?? null]);
  changeBeatAt(doc, on(0), slapPopCycle);
  expect(states()[0]).toEqual([true, null]);
  changeBeatAt(doc, on(0), slapPopCycle);
  expect(states()[0]).toEqual([null, true]);
  changeBeatAt(doc, on(0), slapPopCycle);
  expect(states()[0]).toEqual([null, null]);
  undo.undo();
  expect(states()[0]).toEqual([null, true]);
  undo.undo();
  expect(states()[0]).toEqual([true, null]);
  undo.undo();
  expect(states()).toEqual([
    [null, null],
    [null, null],
    [null, null],
  ]);
});

test("a beat slapped and popped by two members at once reads as slapped: Shift+J takes it to pop alone", () => {
  const { doc, beats, on, stored } = part();
  stored(0).set("slap", true);
  stored(0).set("pop", true);
  expect(readScore(doc).invalid.map((flag) => flag.what)).toEqual(["beat.pop"]);
  changeBeatAt(doc, on(0), slapPopCycle);
  expect(stored(0).get("slap")).toBeUndefined();
  expect(beats()[0]).toMatchObject({ pop: true });
  expect(readScore(doc).invalid).toEqual([]);
});

test("at the cursor, Shift+F's change steps its beat's dynamic from none through pp to ff and back to none", () => {
  const { doc, beats, on } = part();
  const seen = Array.from({ length: 8 }, () => {
    changeBeatAt(doc, on(2), dynamicCycle);
    return beats()[2]!.dynamic ?? null;
  });
  expect(seen).toEqual(["pp", "p", "mp", "mf", "f", "ff", null, "pp"]);
  expect(beats().map((beat) => beat.dynamic ?? null)).toEqual([null, null, "pp"]);
});

test.each(["percussion", "pitched"] as const)("a dynamic goes on a beat of a %s part too; stroke, slap and pop do not, and change nothing there", (kind) => {
  const { doc, beats, on } = part(kind);
  const transactions = transactionsOf(doc);
  changeBeatAt(doc, on(0), strokeCycle);
  changeBeatAt(doc, on(0), slapPopCycle);
  changeBeatsOnSelection(doc, { kind: "bars", partId: on(0).partId, anchorBarId: on(0).barId, focusBarId: on(0).barId }, on(0), strokeCycle);
  expect(transactions.count).toBe(0);
  changeBeatAt(doc, on(0), dynamicCycle);
  expect(beats()[0]).toMatchObject({ dynamic: "pp" });
  // Still read: nothing was written that this kind cannot hold.
  expect(beats()).toHaveLength(3);
});

test("over a selection, each flag takes every beat to the value after the one of its first beat, in one undo step, and rests among them too", () => {
  const { doc, beats, on, range, stored } = part();
  (stored(1).get("notes") as Y.Map<unknown>).clear();
  changeBeatAt(doc, on(0), strokeCycle);
  changeBeatAt(doc, on(2), dynamicCycle);
  changeBeatAt(doc, on(2), dynamicCycle);
  const undo = undoOf(doc);
  changeBeatsOnSelection(doc, range(0, 2), on(0), strokeCycle);
  expect(beats().map((beat) => beat.stroke ?? null)).toEqual(["up", "up", "up"]);
  changeBeatsOnSelection(doc, range(2, 0), on(0), dynamicCycle);
  expect(beats().map((beat) => beat.dynamic ?? null)).toEqual(["pp", "pp", "pp"]);
  changeBeatsOnSelection(doc, range(0, 2), on(0), slapPopCycle);
  expect(beats().map((beat) => beat.slap ?? null)).toEqual([true, true, true]);
  undo.undo();
  undo.undo();
  undo.undo();
  expect(beats().map(({ stroke, dynamic, slap }) => [stroke ?? null, dynamic ?? null, slap ?? null])).toEqual([
    ["down", null, null],
    [null, null, null],
    [null, "p", null],
  ]);
});

test("a text goes over the cursor's beat in one undo step, an empty one takes it away, and one of 65 characters is refused", () => {
  const { doc, beats, on } = part("pitched");
  const undo = undoOf(doc);
  expect(setText(doc, on(1), "Am7")).toBe(true);
  expect(beats()[1]).toMatchObject({ text: "Am7" });
  expect(setText(doc, on(1), "a".repeat(64))).toBe(true);
  expect(beats()[1]!.text).toHaveLength(64);
  const transactions = transactionsOf(doc);
  expect(setText(doc, on(1), "a".repeat(65))).toBe(false);
  // The same text again: nothing to write.
  expect(setText(doc, on(1), "a".repeat(64))).toBe(true);
  expect(transactions.count).toBe(0);
  expect(setText(doc, on(1), "")).toBe(true);
  expect("text" in beats()[1]!).toBe(false);
  undo.undo();
  expect(beats()[1]!.text).toHaveLength(64);
  undo.undo();
  expect(beats()[1]).toMatchObject({ text: "Am7" });
  undo.undo();
  expect(beats().map((beat) => beat.text ?? null)).toEqual([null, null, null]);
});

test("in the append slot there is no beat for a flag or a text; an empty text on a beat without one writes nothing", () => {
  const { doc, on, partId, barIds } = part();
  const transactions = transactionsOf(doc);
  for (const change of [strokeCycle, slapPopCycle, dynamicCycle]) {
    changeBeatAt(doc, { ...on(2), at: "after" }, change);
    changeBeatAt(doc, cursorAt(doc, partId, barIds[1]!), change);
  }
  expect(setText(doc, { ...on(2), at: "after" }, "C")).toBe(true);
  expect(setText(doc, on(0), "")).toBe(true);
  expect(transactions.count).toBe(0);
});

test("a flag keeps the fields of the beat this version does not know, and a beat reading leaves out is not changed", () => {
  const { doc, beats, on, range, stored } = part();
  stored(0).set("future", 1);
  // A dynamic no version has: the beat is left out when read.
  stored(1).set("dynamic", "ffff");
  changeBeatAt(doc, on(0), dynamicCycle);
  changeBeatAt(doc, on(1), dynamicCycle);
  setText(doc, on(1), "C");
  changeBeatsOnSelection(doc, range(0, 2), on(0), strokeCycle);
  expect(stored(0).get("future")).toBe(1);
  expect(stored(1).get("dynamic")).toBe("ffff");
  expect(stored(1).get("text")).toBeUndefined();
  expect(stored(1).get("stroke")).toBeUndefined();
  expect(beats().map(({ dynamic, stroke }) => [dynamic ?? null, stroke ?? null])).toEqual([
    ["pp", "down"],
    [null, "down"],
  ]);
});
