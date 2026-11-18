import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  addPart,
  barsOf,
  beatPositionOf,
  changeBeatAt,
  contentOf,
  createScore,
  type Cursor,
  cursorAt,
  docToJson,
  durationStep,
  insertBars,
  insertBeat,
  LOCAL,
  moveByBar,
  moveByBeat,
  moveByLine,
  moveByStaff,
  moveFromAppendedBeat,
  moveToBarEnd,
  moveToBarStart,
  moveToVoice,
  type Duration,
  observeScore,
  partsOf,
  type ScoreChange,
  setDuration,
  setFret,
  settleCursor,
  startLine,
  VOICE_NOT_OFFERED,
} from "../src/index";
import { appendBeat } from "./support";

/** Write beats of these durations into a bar, one after the other from its first place (its first beat, or an empty voice's append slot); returns their ids. */
function write(doc: Y.Doc, partId: string, barId: string, durations: Duration[]): string[] {
  let cursor = cursorAt(doc, partId, barId);
  return durations.map((duration) => {
    cursor = appendBeat(doc, cursor, duration);
    return cursor.beatId!;
  });
}

const quarter: Duration = { value: 4 };

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
  const triplet: Duration = { value: 4, tuplet: { actual: 3, normal: 2 } };
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
  appendBeat(doc, mine, { value: 8 });
  expect(moveFromAppendedBeat(doc, mine)).toEqual({ ...mine, at: "after" });
  // Once the bar is full, → goes on to the next bar, as from any last beat.
  appendBeat(doc, mine, { value: 4 });
  expect(placeOf(barIds, beats, moveFromAppendedBeat(doc, mine))).toEqual([1, -1, "after"]);
  // At the end of the score it stays.
  setDuration(doc, cursorAt(doc, partId, barIds[4]!), { value: 1 });
  const last = cursorAt(doc, partId, barIds[4]!);
  expect(moveFromAppendedBeat(doc, last)).toEqual(last);
});

test("Home goes to the first place of the bar: its first beat, or the append slot of an empty voice", () => {
  const { doc, barIds, partId, beats } = score();
  const places = [0, 1, 2, 3].map((bar) => {
    const last = beats[bar]!.at(-1);
    const from: Cursor = last === undefined ? cursorAt(doc, partId, barIds[bar]!) : { ...cursorAt(doc, partId, barIds[bar]!), beatId: last, at: bar === 0 ? "after" : "on" };
    return placeOf(barIds, beats, moveToBarStart(doc, from));
  });
  expect(places).toEqual([
    [0, 0, "on"],
    [1, -1, "after"],
    [2, 0, "on"],
    [3, 0, "on"],
  ]);
});

test("End goes to the last place → reaches in the bar: the append slot when the bar is not full, else its last beat", () => {
  const { doc, barIds, partId, beats } = score();
  const places = [0, 1, 2, 3].map((bar) => placeOf(barIds, beats, moveToBarEnd(doc, cursorAt(doc, partId, barIds[bar]!))));
  expect(places).toEqual([
    [0, 1, "after"], // two quarters of four
    [1, -1, "after"], // an empty voice
    [2, 1, "on"], // full
    [3, 1, "on"], // overfull
  ]);
  // From the append slot, End stays there; Home goes back to the first beat.
  const slot: Cursor = { ...cursorAt(doc, partId, barIds[0]!), beatId: beats[0]![1]!, at: "after" };
  expect(moveToBarEnd(doc, slot)).toEqual(slot);
});

test("Nav+→ and Nav+← go to the first place of the next and the bar before, and stay at either end of the score", () => {
  const { doc, barIds, partId, beats } = score();
  const last: Cursor = { ...cursorAt(doc, partId, barIds[0]!), beatId: beats[0]![1]! };
  expect(placeOf(barIds, beats, moveByBar(doc, last, 1))).toEqual([1, -1, "after"]);
  expect(placeOf(barIds, beats, moveByBar(doc, cursorAt(doc, partId, barIds[3]!), -1))).toEqual([2, 0, "on"]);
  const first = cursorAt(doc, partId, barIds[0]!);
  expect(moveByBar(doc, first, -1)).toEqual(first);
  const end = cursorAt(doc, partId, barIds[4]!);
  expect(moveByBar(doc, end, 1)).toEqual(end);
});

test("a cursor whose bar is gone stays where it is when it moves by bar or within its bar, rather than jump to the first bar", () => {
  const { doc, barIds, partId } = score();
  const cursor = cursorAt(doc, partId, barIds[2]!);
  barsOf(doc).delete(barIds[2]!);
  expect(moveByBar(doc, cursor, 1)).toEqual(cursor);
  expect(moveByBar(doc, cursor, -1)).toEqual(cursor);
  expect(moveToBarStart(doc, cursor)).toEqual(cursor);
  expect(moveToBarEnd(doc, cursor)).toEqual(cursor);
});

/**
 * A guitar, a keyboard on two staves and drums, over two bars of 4/4. The first bar: the guitar
 * holds a half and two quarters; the keyboard's upper staff four quarters, its lower staff a
 * whole, its upper staff's second voice a half; the drums nothing.
 */
function band() {
  const doc = new Y.Doc();
  createScore(doc, "Band");
  const barIds = insertBars(doc, { after: null, count: 2 });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted" });
  const keys = addPart(doc, { name: "Keys", kind: "pitched", staves: [{ clef: "treble" }, { clef: "bass" }] });
  const drums = addPart(doc, { name: "Drums", kind: "percussion" });
  const bar = barIds[0]!;
  const voice = (partId: string, key: string, durations: Duration[]) => writeVoice(doc, partId, bar, key, durations);
  const beats = {
    guitar: voice(guitar, "0:0", [{ value: 2 }, quarter, quarter]),
    upper: voice(keys, "0:0", [quarter, quarter, quarter, quarter]),
    second: voice(keys, "0:1", [{ value: 2 }]),
    lower: voice(keys, "1:0", [{ value: 1 }]),
  };
  return { doc, barIds, guitar, keys, drums, beats };
}

/** Write beats of these durations into a voice of a bar, from its start; returns their ids. */
function writeVoice(doc: Y.Doc, partId: string, barId: string, voice: string, durations: Duration[]): string[] {
  let cursor: Cursor = { ...cursorAt(doc, partId, barId), voice, beatId: null, at: "after" };
  return durations.map((duration) => {
    cursor = appendBeat(doc, cursor, duration);
    return cursor.beatId!;
  });
}

test("a fretted part starts on its first string, the other kinds on the middle line of the staff", () => {
  expect(startLine("fretted")).toBe(1);
  expect(startLine("percussion")).toBe(4);
  expect(startLine("pitched")).toBe(4);
  const { doc, barIds, guitar, keys, drums } = band();
  expect([guitar, keys, drums].map((partId) => cursorAt(doc, partId, barIds[1]!).line)).toEqual([1, 4, 4]);
});

test("Nav+↓ goes through the staves of a part, then to the first staff of the next part; Nav+↑ back to the last staff of the one before", () => {
  const { doc, barIds, guitar, keys, drums, beats } = band();
  // On the guitar's third quarter: tick 3 of 4.
  const start: Cursor = { ...cursorAt(doc, guitar, barIds[0]!, 3), beatId: beats.guitar[2]! };
  const down = [start];
  for (let step = 0; step < 4; step++) down.push(moveByStaff(doc, down.at(-1)!, 1));
  expect(down.map(({ partId, voice, beatId, at }) => [partId, voice, beatId, at])).toEqual([
    [guitar, "0:0", beats.guitar[2], "on"],
    [keys, "0:0", beats.upper[3], "on"], // the quarter that starts the fourth beat of the bar
    [keys, "1:0", beats.lower[0], "on"], // the whole holds that tick
    [drums, "0:0", null, "after"], // an empty voice: where End goes
    [drums, "0:0", null, "after"], // the last staff of the last part: it stays
  ]);
  const up = [down.at(-1)!];
  for (let step = 0; step < 4; step++) up.push(moveByStaff(doc, up.at(-1)!, -1));
  expect(up.map(({ partId, voice }) => [partId, voice])).toEqual([
    [drums, "0:0"],
    [keys, "1:0"],
    [keys, "0:0"],
    [guitar, "0:0"],
    [guitar, "0:0"],
  ]);
});

test("moving to another part, the cursor takes the line it had there, else where the part starts, kept within its strings", () => {
  const { doc, barIds, guitar, keys } = band();
  const bass = addPart(doc, { name: "Bass", kind: "fretted", tuning: [43, 38, 33, 28] });
  const onGuitar: Cursor = { ...cursorAt(doc, guitar, barIds[1]!), line: 6 };
  const lines = new Map([[keys, 9]]);
  expect(moveByStaff(doc, onGuitar, 1, lines).line).toBe(9);
  expect(moveByStaff(doc, onGuitar, 1).line).toBe(4);
  // From the keyboard's lower staff, through the drums, to the bass, which has four strings.
  const lower: Cursor = { ...cursorAt(doc, keys, barIds[1]!), voice: "1:0", line: 7 };
  const toBass = moveByStaff(doc, moveByStaff(doc, lower, 1), 1, new Map([[bass, 6]]));
  expect(toBass).toMatchObject({ partId: bass, line: 4 });
  // Through the staves of one part the line stays.
  expect(moveByStaff(doc, { ...cursorAt(doc, keys, barIds[1]!), line: 11 }, 1, new Map([[keys, 2]]))).toMatchObject({ voice: "1:0", line: 11 });
});

test("Nav+↑/↓ keeps the voice of the staff it leaves where the part has it; a fretted part has only its first", () => {
  const { doc, barIds, guitar, keys, beats } = band();
  const second: Cursor = { ...cursorAt(doc, keys, barIds[0]!), voice: "0:1", beatId: beats.second[0]! };
  expect(moveByStaff(doc, second, 1)).toMatchObject({ partId: keys, voice: "1:1", beatId: null, at: "after" });
  expect(moveByStaff(doc, second, -1)).toMatchObject({ partId: guitar, voice: "0:0", beatId: beats.guitar[0], at: "on" });
});

test("in the append slot the cursor stands at the end of its beats: in another voice, on the beat that holds that tick, else where End goes", () => {
  const { doc, barIds, keys, beats } = band();
  // After the upper staff's first quarter: tick 1 of 4, inside the half of the second voice.
  const slot: Cursor = { ...cursorAt(doc, keys, barIds[0]!), beatId: beats.upper[0]!, at: "after" };
  expect(moveToVoice(doc, slot, 1)).toMatchObject({ voice: "0:1", beatId: beats.second[0], at: "on" });
  // From the third quarter, past the half: the second voice is not full, so its append slot.
  const third: Cursor = { ...slot, beatId: beats.upper[2]!, at: "on" };
  expect(moveToVoice(doc, third, 1)).toMatchObject({ voice: "0:1", beatId: beats.second[0], at: "after" });
  // Back from that append slot, at the end of the half: the third quarter.
  expect(moveToVoice(doc, moveToVoice(doc, third, 1) as Cursor, 0)).toMatchObject({ voice: "0:0", beatId: beats.upper[2], at: "on" });
});

test("a voice the cursor is in already leaves the cursor where it is; a fretted part's second voice is not offered", () => {
  const { doc, barIds, guitar, keys, beats } = band();
  const onGuitar: Cursor = { ...cursorAt(doc, guitar, barIds[0]!), beatId: beats.guitar[1]! };
  expect(moveToVoice(doc, onGuitar, 1)).toBe(VOICE_NOT_OFFERED);
  expect(moveToVoice(doc, onGuitar, 0)).toEqual(onGuitar);
  const lower: Cursor = { ...cursorAt(doc, keys, barIds[0]!), voice: "1:0", beatId: beats.lower[0]! };
  expect(moveToVoice(doc, lower, 1)).toMatchObject({ voice: "1:1", beatId: null, at: "after" });
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
  const value = () => docToJson(doc).parts[0]!.content[barIds[0]!]!["0:0"]![0]!.value;
  changeBeatAt(doc, cursor, durationStep(1));
  expect(value()).toBe(8);
  changeBeatAt(doc, cursor, durationStep(-1));
  changeBeatAt(doc, cursor, durationStep(-1));
  changeBeatAt(doc, cursor, durationStep(-1));
  expect(value()).toBe(1);
  const before = docToJson(doc);
  changeBeatAt(doc, cursor, durationStep(-1));
  // An empty voice's append slot has no beat to change.
  changeBeatAt(doc, cursorAt(doc, partId, barIds[1]!), durationStep(1));
  expect(docToJson(doc)).toEqual(before);
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
    changeBeatAt(doc, cursorAt(doc, partId, barIds[2]!), durationStep(1));
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
