import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  addPart,
  barsOf,
  createScore,
  type Cursor,
  cursorAt,
  docToJson,
  insertBars,
  insertBeat,
  LOCAL,
  moveByBeat,
  moveByLine,
  observeScore,
  partsOf,
  type ScoreChange,
  setFret,
  settleCursor,
  stepDuration,
  valueAt,
} from "../src/index";

/** Three bars: two beats, none, one beat. */
function score() {
  const doc = new Y.Doc();
  createScore(doc, "Demo");
  const barIds = insertBars(doc, { after: null, count: 3 });
  const partId = addPart(doc, { name: "Guitar", kind: "fretted" });
  const a = insertBeat(doc, cursorAt(doc, partId, barIds[0]!), { value: 4 });
  const b = insertBeat(doc, a, { value: 4 });
  const c = insertBeat(doc, cursorAt(doc, partId, barIds[2]!), { value: 4 });
  return { doc, barIds, partId, beats: [a.beatId, b.beatId, c.beatId] };
}

test("the cursor walks beat by beat through bars, standing before the first beat of an empty one", () => {
  const { doc, barIds, partId, beats } = score();
  let cursor = cursorAt(doc, partId, barIds[0]!, 3);
  const seen: [string, string | null][] = [[cursor.barId, cursor.beatId]];
  for (let i = 0; i < 4; i++) {
    cursor = moveByBeat(doc, cursor, 1);
    seen.push([cursor.barId, cursor.beatId]);
  }
  expect(seen).toEqual([
    [barIds[0], beats[0]],
    [barIds[0], beats[1]],
    [barIds[1], null],
    [barIds[2], beats[2]],
    [barIds[2], beats[2]], // the end of the score
  ]);
  expect(cursor.line).toBe(3);

  const back: [string, string | null][] = [];
  for (let i = 0; i < 4; i++) {
    cursor = moveByBeat(doc, cursor, -1);
    back.push([cursor.barId, cursor.beatId]);
  }
  expect(back).toEqual([
    [barIds[1], null],
    [barIds[0], beats[1]],
    [barIds[0], beats[0]],
    [barIds[0], beats[0]], // the start of the score
  ]);
});

test("the cursor moves across the strings of its part and stops at the outer ones", () => {
  const { doc, barIds, partId } = score();
  let cursor = cursorAt(doc, partId, barIds[0]!, 5);
  cursor = moveByLine(doc, cursor, 1);
  expect(cursor.line).toBe(6);
  expect(moveByLine(doc, cursor, 1).line).toBe(6);
  expect(moveByLine(doc, { ...cursor, line: 1 }, -1).line).toBe(1);
});

test("a cursor whose beat is gone settles on the last beat of its bar", () => {
  const { doc, barIds, partId, beats } = score();
  const undo = new Y.UndoManager([barsOf(doc), partsOf(doc)], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
  const cursor = insertBeat(doc, { ...cursorAt(doc, partId, barIds[0]!), beatId: beats[1]! }, { value: 8 });
  expect(settleCursor(doc, cursor)).toEqual(cursor);
  undo.undo();
  expect(settleCursor(doc, cursor)).toEqual({ ...cursor, beatId: beats[1] });
  const empty = cursorAt(doc, partId, barIds[1]!);
  expect(settleCursor(doc, empty)).toEqual(empty);
  expect(settleCursor(doc, { ...cursor, partId: "gone" })).toBeNull();
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
  const first: Cursor = { ...cursorAt(doc, partId, barIds[0]!, 2), beatId: beats[0]! };

  setFret(doc, first, 5);
  insertBeat(doc, cursorAt(doc, partId, barIds[1]!), { value: 8 });
  doc.transact(() => {
    setFret(doc, first, 7);
    stepDuration(doc, cursorAt(doc, partId, barIds[2]!), 1);
  }, LOCAL);
  insertBars(doc, { after: barIds[2]!, count: 1 });
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
