import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  addPart,
  barsOf,
  beatPositionOf,
  contentOf,
  createScore,
  type Cursor,
  cursorAt,
  docToJson,
  insertBars,
  insertBeat,
  LOCAL,
  moveByBeat,
  moveByLine,
  moveFromAppendedBeat,
  type NewBeat,
  observeScore,
  partsOf,
  type ScoreChange,
  setDuration,
  setFret,
  settleCursor,
  stepDuration,
  valueAt,
} from "../src/index";

/** Append beats of these durations to a bar; returns their ids. */
function write(doc: Y.Doc, partId: string, barId: string, durations: NewBeat[]): string[] {
  let cursor = cursorAt(doc, partId, barId);
  return durations.map((duration) => {
    cursor = insertBeat(doc, { ...cursor, at: "after" }, duration);
    return cursor.beatId!;
  });
}

const quarter: NewBeat = { value: 4 };

/**
 * Five bars of 4/4: two quarters (not full), none, a dotted half and a quarter (full), a whole
 * and a quarter (overfull), and one quarter.
 */
function score() {
  const doc = new Y.Doc();
  createScore(doc, "Demo");
  const barIds = insertBars(doc, { after: null, count: 5 });
  const partId = addPart(doc, { name: "Guitar", kind: "fretted" });
  const beats = [
    write(doc, partId, barIds[0]!, [quarter, quarter]),
    [],
    write(doc, partId, barIds[2]!, [{ value: 2, dots: 1 }, quarter]),
    write(doc, partId, barIds[3]!, [{ value: 1 }, quarter]),
    write(doc, partId, barIds[4]!, [quarter]),
  ];
  return { doc, barIds, partId, beats };
}

/** Where a cursor stands, by bar and beat index: [bar, beat, at], the beat -1 for none. */
function placeOf(barIds: string[], beats: string[][], cursor: Cursor): [number, number, "on" | "after"] {
  const bar = barIds.indexOf(cursor.barId);
  return [bar, cursor.beatId === null ? -1 : beats[bar]!.indexOf(cursor.beatId), cursor.at];
}

function walk(doc: Y.Doc, from: Cursor, step: 1 | -1, times: number): Cursor[] {
  const seen = [from];
  for (let i = 0; i < times; i++) seen.push(moveByBeat(doc, seen.at(-1)!, step));
  return seen;
}

test("the first place of a bar is its first beat, or the append slot of its voice when it is empty", () => {
  const { doc, barIds, partId, beats } = score();
  expect(cursorAt(doc, partId, barIds[0]!, 3)).toEqual({ partId, barId: barIds[0], voice: "0:0", beatId: beats[0]![0], at: "on", line: 3 });
  expect(cursorAt(doc, partId, barIds[1]!, 3)).toEqual({ partId, barId: barIds[1], voice: "0:0", beatId: null, at: "after", line: 3 });
});

test("→ walks the beats of a bar, then into its append slot when the bar is not full, then to the first place of the next bar", () => {
  const { doc, barIds, partId, beats } = score();
  const seen = walk(doc, cursorAt(doc, partId, barIds[0]!, 3), 1, 4);
  expect(seen.map((cursor) => placeOf(barIds, beats, cursor))).toEqual([
    [0, 0, "on"],
    [0, 1, "on"],
    [0, 1, "after"], // the bar holds two quarters of four
    [1, -1, "after"], // an empty voice: its append slot
    [2, 0, "on"],
  ]);
  expect(seen.every((cursor) => cursor.line === 3)).toBe(true);
});

test("→ from the last beat of a full or an overfull bar goes straight to the first beat of the next bar", () => {
  const { doc, barIds, partId, beats } = score();
  const seen = walk(doc, cursorAt(doc, partId, barIds[2]!), 1, 4);
  expect(seen.map((cursor) => placeOf(barIds, beats, cursor))).toEqual([
    [2, 0, "on"],
    [2, 1, "on"], // a dotted half and a quarter fill the bar
    [3, 0, "on"],
    [3, 1, "on"], // a whole and a quarter overfill it
    [4, 0, "on"],
  ]);
});

test("→ at the end of the last bar stays where it is: in its append slot, or on its last beat when the bar is full", () => {
  const { doc, barIds, partId, beats } = score();
  const seen = walk(doc, cursorAt(doc, partId, barIds[4]!), 1, 2);
  expect(seen.map((cursor) => placeOf(barIds, beats, cursor))).toEqual([
    [4, 0, "on"],
    [4, 0, "after"],
    [4, 0, "after"],
  ]);
  setDuration(doc, cursorAt(doc, partId, barIds[4]!), { value: 1 });
  const full = cursorAt(doc, partId, barIds[4]!);
  expect(moveByBeat(doc, full, 1)).toEqual(full);
});

test("a beat in a triplet counts for two thirds of its value when the cursor asks whether its bar is full", () => {
  const { doc, barIds, partId } = score();
  const triplet: NewBeat = { value: 4, tuplet: { actual: 3, normal: 2 } };
  const written = write(doc, partId, barIds[1]!, [triplet, triplet, triplet, { value: 2 }]);
  // Three quarter-note triplets and a half: a whole, so → leaves the bar.
  const last: Cursor = { ...cursorAt(doc, partId, barIds[1]!), beatId: written[3]! };
  expect(moveByBeat(doc, last, 1)).toMatchObject({ barId: barIds[2], at: "on" });
});

test("→ from an append slot goes to the next bar, even when others have appended after its anchor", () => {
  const { doc, barIds, partId, beats } = score();
  const slot: Cursor = { ...cursorAt(doc, partId, barIds[0]!), beatId: beats[0]![1]!, at: "after" };
  insertBeat(doc, slot, quarter);
  expect(placeOf(barIds, beats, moveByBeat(doc, slot, 1))).toEqual([1, -1, "after"]);
});

test("← goes from the first beat to the last beat of the bar before, into the append slot of an empty one, and stays at the start", () => {
  const { doc, barIds, partId, beats } = score();
  const seen = walk(doc, cursorAt(doc, partId, barIds[2]!), -1, 4);
  expect(seen.map((cursor) => placeOf(barIds, beats, cursor))).toEqual([
    [2, 0, "on"],
    [1, -1, "after"],
    [0, 1, "on"], // not the append slot of the bar before
    [0, 0, "on"],
    [0, 0, "on"], // the start of the score
  ]);
});

test("← from an append slot goes back to its anchor, even when others have appended after it", () => {
  const { doc, barIds, partId, beats } = score();
  const slot: Cursor = { ...cursorAt(doc, partId, barIds[0]!), beatId: beats[0]![1]!, at: "after" };
  insertBeat(doc, slot, quarter);
  expect(placeOf(barIds, beats, moveByBeat(doc, slot, -1))).toEqual([0, 1, "on"]);
});

test("→ from a beat just made in the append slot takes it as the new anchor, whatever others have appended after it", () => {
  const { doc, barIds, partId, beats } = score();
  const mine = insertBeat(doc, { ...cursorAt(doc, partId, barIds[0]!), beatId: beats[0]![1]!, at: "after" }, { value: 8 });
  insertBeat(doc, { ...mine, at: "after" }, { value: 8 });
  expect(moveFromAppendedBeat(doc, mine)).toEqual({ ...mine, at: "after" });
  // Once the bar is full, → goes on to the next bar, as from any last beat.
  insertBeat(doc, { ...mine, at: "after" }, { value: 4 });
  expect(placeOf(barIds, beats, moveFromAppendedBeat(doc, mine))).toEqual([1, -1, "after"]);
  // At the end of the score it stays.
  setDuration(doc, cursorAt(doc, partId, barIds[4]!), { value: 1 });
  const last = cursorAt(doc, partId, barIds[4]!);
  expect(moveFromAppendedBeat(doc, last)).toEqual(last);
});

test("the cursor moves across the strings of its part and stops at the outer ones", () => {
  const { doc, barIds, partId } = score();
  let cursor = cursorAt(doc, partId, barIds[0]!, 5);
  cursor = moveByLine(doc, cursor, 1);
  expect(cursor.line).toBe(6);
  expect(moveByLine(doc, cursor, 1).line).toBe(6);
  expect(moveByLine(doc, { ...cursor, line: 1 }, -1).line).toBe(1);
});

/** Remove beats of a voice, as another member's change would. */
function removeBeats(doc: Y.Doc, partId: string, barId: string, index: number, length: number): void {
  contentOf(partsOf(doc).get(partId)!).get(barId)!.get("0:0")!.delete(index, length);
}

/** Another member's copy of the score: they remove beats there, and the change is handed to ours. */
function removedByAnother(doc: Y.Doc, partId: string, barId: string, index: number, length: number): void {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  const before = Y.encodeStateVector(other);
  removeBeats(other, partId, barId, index, length);
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, before));
}

/** A cursor on each of the five beats of the first bar, and where each stands. */
function onEachBeat() {
  const { doc, barIds, partId } = score();
  write(doc, partId, barIds[0]!, [{ value: 16 }, { value: 16 }, { value: 16 }]);
  const ids = docToJson(doc).parts[0]!.content[barIds[0]!]!["0:0"]!.map((beat) => beat.id);
  const cursors = ids.map((beatId): Cursor => ({ ...cursorAt(doc, partId, barIds[0]!, 2), beatId }));
  return { doc, barIds, partId, ids, cursors, positions: cursors.map((cursor) => beatPositionOf(doc, cursor)) };
}

test("a cursor whose beat another member removes lands on the beat that took its place", () => {
  const { doc, barIds, partId, ids, cursors, positions } = onEachBeat();
  removedByAnother(doc, partId, barIds[0]!, 2, 1);
  expect(settleCursor(doc, cursors[2]!, positions[2])).toEqual({ ...cursors[2], beatId: ids[3] });
  // Beats still there stay where they are.
  expect(settleCursor(doc, cursors[1]!, positions[1])).toEqual(cursors[1]);
});

test("a cursor whose beat was the last one removed lands on the beat before", () => {
  const { doc, barIds, partId, ids, cursors, positions } = onEachBeat();
  removedByAnother(doc, partId, barIds[0]!, 4, 1);
  expect(settleCursor(doc, cursors[4]!, positions[4])).toEqual({ ...cursors[4], beatId: ids[3] });
});

test("several beats removed at once: the cursor lands on the first one left after them", () => {
  const { doc, barIds, partId, ids, cursors, positions } = onEachBeat();
  removedByAnother(doc, partId, barIds[0]!, 1, 3);
  expect(settleCursor(doc, cursors[2]!, positions[2])).toEqual({ ...cursors[2], beatId: ids[4] });
});

test("a cursor whose voice another member empties lands in the append slot of the empty voice", () => {
  const { doc, barIds, partId, cursors, positions } = onEachBeat();
  removedByAnother(doc, partId, barIds[0]!, 0, 5);
  expect(settleCursor(doc, cursors[2]!, positions[2])).toEqual({ ...cursors[2], beatId: null, at: "after" });
});

test("a beat this member made and then undid leaves the cursor on the beat before it", () => {
  const { doc, barIds, partId, beats } = score();
  const undo = new Y.UndoManager([barsOf(doc), partsOf(doc)], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
  const cursor = insertBeat(doc, { ...cursorAt(doc, partId, barIds[0]!), beatId: beats[0]![1]!, at: "after" }, { value: 8 });
  const position = beatPositionOf(doc, cursor);
  expect(settleCursor(doc, cursor, position)).toEqual(cursor);
  undo.undo();
  expect(settleCursor(doc, cursor, position)).toEqual({ ...cursor, beatId: beats[0]![1] });
  expect(settleCursor(doc, { ...cursor, partId: "gone" }, position)).toBeNull();
});

test("without where its beat stood, a cursor whose beat is gone lands on the last beat of its voice", () => {
  const { doc, barIds, partId, ids, cursors } = onEachBeat();
  removeBeats(doc, partId, barIds[0]!, 1, 1);
  expect(settleCursor(doc, cursors[1]!)).toEqual({ ...cursors[1], beatId: ids[4] });
});

test("an append slot whose anchor is gone settles after the last beat of its voice; one whose anchor is still there stays", () => {
  const { doc, barIds, partId, beats } = score();
  const slot: Cursor = { ...cursorAt(doc, partId, barIds[0]!), beatId: beats[0]![0]!, at: "after" };
  const added = insertBeat(doc, { ...slot, beatId: beats[0]![1]! }, quarter);
  expect(settleCursor(doc, slot)).toEqual(slot);
  removeBeats(doc, partId, barIds[0]!, 0, 1);
  expect(settleCursor(doc, slot)).toEqual({ ...slot, beatId: added.beatId });
  removeBeats(doc, partId, barIds[0]!, 0, 2);
  expect(settleCursor(doc, slot)).toEqual({ ...slot, beatId: null });
  const empty = cursorAt(doc, partId, barIds[1]!);
  expect(settleCursor(doc, empty)).toEqual(empty);
});

test("a beat gets shorter or longer one note value at a time, within the values there are", () => {
  const { doc, barIds, partId } = score();
  const cursor = cursorAt(doc, partId, barIds[0]!);
  stepDuration(doc, cursor, 1);
  expect(valueAt(doc, cursor)).toBe(8);
  stepDuration(doc, cursor, -1);
  stepDuration(doc, cursor, -1);
  stepDuration(doc, cursor, -1);
  expect(valueAt(doc, cursor)).toBe(1);
  const before = docToJson(doc);
  stepDuration(doc, cursor, -1);
  expect(docToJson(doc)).toEqual(before);
  expect(valueAt(doc, cursorAt(doc, partId, barIds[1]!))).toBeUndefined();
});

test("a change inside bars names those bars; anything else is a change of structure", () => {
  const { doc, barIds, partId, beats } = score();
  const seen: ScoreChange[] = [];
  const stop = observeScore(doc, (change) => seen.push(change));
  const first: Cursor = { ...cursorAt(doc, partId, barIds[0]!, 2), beatId: beats[0]![0]! };

  setFret(doc, first, 5);
  insertBeat(doc, cursorAt(doc, partId, barIds[1]!), { value: 8 });
  doc.transact(() => {
    setFret(doc, first, 7);
    stepDuration(doc, cursorAt(doc, partId, barIds[2]!), 1);
  }, LOCAL);
  insertBars(doc, { after: barIds[4]!, count: 1 });
  addPart(doc, { name: "Bass", kind: "fretted" });
  stop();
  setFret(doc, first, 9);

  expect(seen).toEqual([
    { kind: "content", barIds: new Set([barIds[0]]) },
    { kind: "content", barIds: new Set([barIds[1]]) },
    { kind: "content", barIds: new Set([barIds[0], barIds[2]]) },
    { kind: "structure" },
    { kind: "structure" },
  ]);
});
