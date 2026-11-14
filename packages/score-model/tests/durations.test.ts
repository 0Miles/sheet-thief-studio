// Changing whole beats (docs/spec/commands.md, 5.3 and 5.6): their durations, and clearing them
// to rests, at the cursor and over a selection.
import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  addPart,
  type BeatChange,
  changeBeatAt,
  changeBeatsOnSelection,
  clearNotes,
  contentOf,
  createScore,
  type Cursor,
  cursorAt,
  docToJson,
  type Duration,
  dotCycle,
  durationStep,
  insertBars,
  metaOf,
  partsOf,
  type Selection,
  setFret,
  setTitle,
  tripletToggle,
} from "../src/index";
import { appendBeat, transactionsOf, undoOf } from "./support";

/** A guitar over two bars; the first holds beats of these durations, each with a fret on string 2. */
function guitar(durations: Duration[]) {
  const doc = new Y.Doc();
  createScore(doc, "Demo");
  const barIds = insertBars(doc, { after: null, count: 2 });
  const partId = addPart(doc, { name: "Guitar", kind: "fretted" });
  let cursor: Cursor = cursorAt(doc, partId, barIds[0]!, 2);
  const ids = durations.map((duration, index) => {
    cursor = appendBeat(doc, cursor, duration);
    setFret(doc, cursor, index + 1);
    return cursor.beatId!;
  });
  const beats = (bar = 0) => docToJson(doc).parts[0]!.content[barIds[bar]!]!["0:0"]!;
  const on = (index: number): Cursor => ({ ...cursorAt(doc, partId, barIds[0]!, 2), beatId: ids[index]!, at: "on" });
  const range = (first: number, last: number): Extract<Selection, { kind: "beats" }> => ({ kind: "beats", partId, barId: barIds[0]!, voice: "0:0", anchorBeatId: ids[first]!, focusBeatId: ids[last]! });
  return { doc, barIds, partId, ids, beats, on, range };
}

const durations = (beats: { value: number; dots: number; tuplet?: unknown }[]) => beats.map(({ value, dots, tuplet }) => (tuplet ? [value, dots, tuplet] : [value, dots]));
const triplet = { actual: 3, normal: 2 };

test("at the cursor, + and - make its beat one note value shorter or longer, keeping its dots; the values at either end stay", () => {
  const { doc, beats, on } = guitar([{ value: 4, dots: 1 }, { value: 64 }]);
  changeBeatAt(doc, on(0), durationStep(1));
  changeBeatAt(doc, on(1), durationStep(1));
  expect(durations(beats())).toEqual([
    [8, 1],
    [64, 0],
  ]);
  changeBeatAt(doc, on(0), durationStep(-1));
  changeBeatAt(doc, on(0), durationStep(-1));
  expect(beats()[0]).toMatchObject({ value: 2, dots: 1 });
});

test("over a selection, + and - step every beat one note value, in one undo step; a beat at either end stays", () => {
  const { doc, beats, on, range } = guitar([{ value: 4 }, { value: 1 }, { value: 64 }, { value: 2 }]);
  const undo = undoOf(doc);
  expect(changeBeatsOnSelection(doc, range(0, 2), on(1), durationStep(1))).toEqual(on(1));
  expect(beats().map((beat) => beat.value)).toEqual([8, 2, 64, 2]);
  changeBeatsOnSelection(doc, range(0, 2), on(1), durationStep(-1));
  changeBeatsOnSelection(doc, range(0, 2), on(1), durationStep(-1));
  expect(beats().map((beat) => beat.value)).toEqual([2, 1, 16, 2]);
  undo.undo();
  expect(beats().map((beat) => beat.value)).toEqual([4, 1, 32, 2]);
  // The notes are as they were.
  expect(beats().map((beat) => beat.notes.s2?.fret)).toEqual([1, 2, 3, 4]);
});

test("at the cursor, . cycles the dots of its beat: none, one, two, none", () => {
  const { doc, beats, on } = guitar([{ value: 4 }]);
  const seen = [0, 1, 2, 3].map(() => {
    changeBeatAt(doc, on(0), dotCycle);
    return beats()[0]!.dots;
  });
  expect(seen).toEqual([1, 2, 0, 1]);
});

test("over a selection, . takes every beat to the dots after those of its first beat", () => {
  const { doc, beats, on, range } = guitar([{ value: 8, dots: 1 }, { value: 8 }, { value: 8, dots: 2 }]);
  changeBeatsOnSelection(doc, range(2, 0), on(0), dotCycle);
  expect(beats().map((beat) => beat.dots)).toEqual([2, 2, 2]);
  changeBeatsOnSelection(doc, range(0, 2), on(0), dotCycle);
  expect(beats().map((beat) => beat.dots)).toEqual([0, 0, 0]);
});

test("at the cursor, a triplet goes on a beat without a tuplet, and any tuplet comes off", () => {
  const { doc, beats, on } = guitar([{ value: 8 }, { value: 8, tuplet: { actual: 5, normal: 4 } }]);
  changeBeatAt(doc, on(0), tripletToggle);
  changeBeatAt(doc, on(1), tripletToggle);
  expect(durations(beats())).toEqual([[8, 0, triplet], [8, 0]]);
  changeBeatAt(doc, on(0), tripletToggle);
  expect(durations(beats())).toEqual([
    [8, 0],
    [8, 0],
  ]);
});

test("over a selection, every beat becomes a triplet unless all of them have a tuplet, then every tuplet comes off", () => {
  const { doc, beats, on, range } = guitar([{ value: 8 }, { value: 8, tuplet: { actual: 5, normal: 4 } }, { value: 8 }]);
  changeBeatsOnSelection(doc, range(0, 2), on(0), tripletToggle);
  // All of them, the beat with a tuplet of its own among them.
  expect(durations(beats())).toEqual([
    [8, 0, triplet],
    [8, 0, triplet],
    [8, 0, triplet],
  ]);
  changeBeatsOnSelection(doc, range(0, 2), on(0), tripletToggle);
  expect(durations(beats())).toEqual([
    [8, 0],
    [8, 0],
    [8, 0],
  ]);
});

test("clearing a beat takes its notes away and keeps everything else it holds; a rest changes nothing", () => {
  const { doc, partId, barIds, beats, on } = guitar([{ value: 8, dots: 1 }, { value: 4 }]);
  const stored = contentOf(partsOf(doc).get(partId)!).get(barIds[0]!)!.get("0:0")!.get(0);
  doc.transact(() => {
    stored.set("text", "Am");
    stored.set("future", 1);
  });
  setFret(doc, { ...on(0), line: 5 }, 9);
  changeBeatAt(doc, on(0), clearNotes);
  expect(beats()[0]).toEqual({ id: beats()[0]!.id, value: 8, dots: 1, text: "Am", notes: {} });
  expect(stored.get("future")).toBe(1);
  const transactions = transactionsOf(doc);
  changeBeatAt(doc, on(0), clearNotes);
  expect(transactions.count).toBe(0);
});

test("over a bar range, clearing takes the notes off every beat of every voice of the part in those bars, in one undo step", () => {
  const { doc, partId, barIds, beats, on } = guitar([{ value: 4 }, { value: 4 }]);
  setFret(doc, { ...cursorAt(doc, partId, barIds[0]!, 3), voice: "0:1", beatId: null, at: "after" }, 7);
  setFret(doc, cursorAt(doc, partId, barIds[1]!, 3), 8);
  const undo = undoOf(doc);
  const bars: Selection = { kind: "bars", partId, anchorBarId: barIds[1]!, focusBarId: barIds[0]! };
  changeBeatsOnSelection(doc, bars, on(0), clearNotes);
  const content = docToJson(doc).parts[0]!.content;
  const notes = Object.values(content).flatMap((voices) => Object.values(voices).flat().map((beat) => beat.notes));
  expect(notes).toEqual([{}, {}, {}, {}]);
  undo.undo();
  expect(beats().map((beat) => beat.notes)).toEqual([{ s2: { fret: 1 } }, { s2: { fret: 2 } }]);
  expect(beats(1).map((beat) => beat.notes)).toEqual([{ s3: { fret: 8 } }]);
});

test("in the append slot there is no beat to change; a selection whose beats are gone changes nothing", () => {
  const { doc, partId, barIds, ids, on, range } = guitar([{ value: 4 }]);
  const transactions = transactionsOf(doc);
  const changes: BeatChange<unknown>[] = [durationStep(1), dotCycle, tripletToggle, clearNotes];
  for (const change of changes) {
    changeBeatAt(doc, { ...on(0), at: "after" }, change);
    changeBeatAt(doc, cursorAt(doc, partId, barIds[1]!), change);
    changeBeatsOnSelection(doc, { ...range(0, 0), focusBeatId: "gone" }, on(0), change);
  }
  expect(transactions.count).toBe(0);
  expect(ids).toHaveLength(1);
});

test("a beat reading leaves out is neither seen nor changed, at the cursor or over a selection", () => {
  const { doc, partId, barIds, beats, on, range } = guitar([{ value: 4 }, { value: 8 }, { value: 8 }]);
  const voice = contentOf(partsOf(doc).get(partId)!).get(barIds[0]!)!.get("0:0")!;
  // A dot count no version has: the beat is left out when read.
  voice.get(0).set("dots", 3);
  const transactions = transactionsOf(doc);
  changeBeatAt(doc, on(0), durationStep(1));
  expect(transactions.count).toBe(0);
  // Dots are decided from the first beat the members see: the eighth with none.
  changeBeatsOnSelection(doc, range(0, 2), on(0), dotCycle);
  expect(voice.get(0).get("dots")).toBe(3);
  expect(beats().map((beat) => beat.dots)).toEqual([1, 1]);
});

test("the title is set in one command, between 1 and 100 characters; any other length is not set", () => {
  const doc = new Y.Doc();
  createScore(doc, "Demo");
  expect(setTitle(doc, "新歌")).toBe(true);
  expect(docToJson(doc).title).toBe("新歌");
  const transactions = transactionsOf(doc);
  expect(setTitle(doc, "")).toBe(false);
  expect(setTitle(doc, "a".repeat(101))).toBe(false);
  expect(transactions.count).toBe(0);
  expect(metaOf(doc).get("title")).toBe("新歌");
});
