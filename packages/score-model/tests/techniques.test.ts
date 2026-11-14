// Turning the techniques of a note on and off (docs/spec/commands.md, 5.4): at the cursor, and
// over a selection.
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
  LOCAL,
  NOTE_FLAGS,
  partsOf,
  setFret,
  setNote,
  type Selection,
  toggleNoteFlag,
  toggleNoteFlagIn,
} from "../src/index";
import { appendBeat } from "./support";

/** A guitar with one bar, its first beat holding fret 5 on string 3; the cursor on that beat and string. */
function guitar() {
  const doc = new Y.Doc();
  createScore(doc, "Demo");
  const [barId] = insertBars(doc, { after: null, count: 2 });
  const partId = addPart(doc, { name: "Guitar", kind: "fretted" });
  const cursor: Cursor = { ...setFret(doc, cursorAt(doc, partId, barId!, 3), 5), line: 3 };
  const notes = (bar = barId!) => docToJson(doc).parts[0]!.content[bar]!["0:0"]!.map((beat) => beat.notes);
  return { doc, barId: barId!, partId, cursor, notes };
}

function undoOf(doc: Y.Doc): Y.UndoManager {
  return new Y.UndoManager([barsOf(doc), partsOf(doc)], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
}

test.each(NOTE_FLAGS)("%s turns on and off on the note of the cursor's string, one undo step each, keeping its fret", (flag) => {
  const { doc, cursor, notes } = guitar();
  const undo = undoOf(doc);
  expect(toggleNoteFlag(doc, cursor, "s3", flag)).toEqual(cursor);
  expect(notes()).toEqual([{ s3: { fret: 5, [flag]: true } }]);
  toggleNoteFlag(doc, cursor, "s3", flag);
  expect(notes()).toEqual([{ s3: { fret: 5 } }]);
  undo.undo();
  expect(notes()).toEqual([{ s3: { fret: 5, [flag]: true } }]);
  undo.undo();
  expect(notes()).toEqual([{ s3: { fret: 5 } }]);
});

test("a toggle keeps what else the note holds, fields this version does not know among them", () => {
  const { doc, cursor, notes } = guitar();
  setNote(doc, cursor, "s3", { fret: 5, ghost: true, futureField: 1 } as never);
  toggleNoteFlag(doc, cursor, "s3", "accent");
  toggleNoteFlag(doc, cursor, "s3", "ghost");
  const stored = (partsOf(doc).get(cursor.partId)!.get("content") as Y.Map<Y.Map<Y.Array<Y.Map<unknown>>>>).get(cursor.barId)!.get("0:0")!.get(0).get("notes") as Y.Map<unknown>;
  expect(stored.get("s3")).toEqual({ fret: 5, accent: true, futureField: 1 });
  expect(notes()).toEqual([{ s3: { fret: 5, accent: true } }]);
});

test("on a string with no note, dead makes a dead note without a fret, and again takes it away; the other flags do nothing", () => {
  const { doc, cursor, notes } = guitar();
  const empty = { ...cursor, line: 1 };
  const counted = { transactions: 0 };
  doc.on("afterTransaction", () => (counted.transactions += 1));
  for (const flag of NOTE_FLAGS.filter((each) => each !== "dead")) toggleNoteFlag(doc, empty, "s1", flag);
  expect(counted.transactions).toBe(0);
  expect(notes()).toEqual([{ s3: { fret: 5 } }]);
  toggleNoteFlag(doc, empty, "s1", "dead");
  expect(notes()).toEqual([{ s3: { fret: 5 }, s1: { dead: true } }]);
  toggleNoteFlag(doc, empty, "s1", "dead");
  expect(notes()).toEqual([{ s3: { fret: 5 } }]);
});

test("dead on a fretted note keeps its fret, and off again leaves the note as it was", () => {
  const { doc, cursor, notes } = guitar();
  toggleNoteFlag(doc, cursor, "s3", "dead");
  expect(notes()).toEqual([{ s3: { fret: 5, dead: true } }]);
  toggleNoteFlag(doc, cursor, "s3", "dead");
  expect(notes()).toEqual([{ s3: { fret: 5 } }]);
});

test("dead in the append slot makes a beat there with a dead note, and the cursor moves onto it", () => {
  const { doc, cursor, notes } = guitar();
  const slot: Cursor = { ...cursor, at: "after" };
  expect(toggleNoteFlag(doc, slot, "s3", "ghost")).toEqual(slot);
  expect(notes()).toHaveLength(1);
  const next = toggleNoteFlag(doc, slot, "s3", "dead");
  expect(notes()).toEqual([{ s3: { fret: 5 } }, { s3: { dead: true } }]);
  expect(next).toMatchObject({ beatId: docToJson(doc).parts[0]!.content[cursor.barId]!["0:0"]![1]!.id, at: "on" });
  // A beat inserted after it is a rest of the same length: the dead note is a note like any other.
  appendBeat(doc, next);
  expect(notes()).toEqual([{ s3: { fret: 5 } }, { s3: { dead: true } }, {}]);
});

/** A guitar whose first bar holds three beats, a chord on the second; a bass with a note in the same bar. */
function selected() {
  const { doc, barId, partId, cursor, notes } = guitar();
  const second = appendBeat(doc, cursor);
  setNote(doc, second, "s1", { fret: 0 });
  setNote(doc, second, "s2", { fret: 1, ghost: true });
  const third = appendBeat(doc, second);
  setNote(doc, third, "s3", { fret: 7 });
  const bass = addPart(doc, { name: "Bass", kind: "fretted", tuning: [43, 38, 33, 28] });
  setFret(doc, cursorAt(doc, bass, barId, 1), 3);
  const ids = docToJson(doc).parts[0]!.content[barId]!["0:0"]!.map((beat) => beat.id);
  const range: Selection = { kind: "beats", partId, barId, voice: "0:0", anchorBeatId: ids[0]!, focusBeatId: ids[1]! };
  const bassNotes = () => docToJson(doc).parts[1]!.content[barId]!["0:0"]!.map((beat) => beat.notes);
  return { doc, barId, partId, cursor, notes, range, ids, bassNotes };
}

test("over a beat range, a flag goes on every note unless all of them have it, then off all of them, in one undo step", () => {
  const { doc, cursor, notes, range, bassNotes } = selected();
  const undo = undoOf(doc);
  expect(toggleNoteFlagIn(doc, range, cursor, "ghost")).toEqual(cursor);
  expect(notes()).toEqual([{ s3: { fret: 5, ghost: true } }, { s1: { fret: 0, ghost: true }, s2: { fret: 1, ghost: true } }, { s3: { fret: 7 } }]);
  toggleNoteFlagIn(doc, range, cursor, "ghost");
  expect(notes()).toEqual([{ s3: { fret: 5 } }, { s1: { fret: 0 }, s2: { fret: 1 } }, { s3: { fret: 7 } }]);
  undo.undo();
  expect(notes()[1]).toEqual({ s1: { fret: 0, ghost: true }, s2: { fret: 1, ghost: true } });
  undo.undo();
  expect(notes()[1]).toEqual({ s1: { fret: 0 }, s2: { fret: 1, ghost: true } });
  expect(bassNotes()).toEqual([{ s1: { fret: 3 } }]);
});

test("over a bar range, a flag goes on every note of the part in those bars, in every voice", () => {
  const { doc, barId, partId, cursor, notes, bassNotes } = selected();
  const [, nextBar] = docToJson(doc).bars.map((bar) => bar.id);
  setFret(doc, { ...cursorAt(doc, partId, barId, 2), voice: "0:1", beatId: null, at: "after" }, 9);
  setFret(doc, cursorAt(doc, partId, nextBar!, 4), 2);
  toggleNoteFlagIn(doc, { kind: "bars", partId, anchorBarId: nextBar!, focusBarId: barId }, cursor, "palmMute");
  expect(notes().flatMap((beat) => Object.values(beat))).toEqual([5, 0, 1, 7].map((fret) => expect.objectContaining({ fret, palmMute: true })));
  expect(notes(nextBar)).toEqual([{ s4: { fret: 2, palmMute: true } }]);
  expect(docToJson(doc).parts[0]!.content[barId]!["0:1"]!.map((beat) => beat.notes)).toEqual([{ s2: { fret: 9, palmMute: true } }]);
  expect(bassNotes()).toEqual([{ s1: { fret: 3 } }]);
});

test("over a selection, dead makes no notes on empty strings, and off takes away the dead notes that have no fret", () => {
  const { doc, cursor, notes, range } = selected();
  setNote(doc, cursor, "s6", { dead: true });
  toggleNoteFlagIn(doc, range, cursor, "dead");
  expect(notes().slice(0, 2)).toEqual([
    { s3: { fret: 5, dead: true }, s6: { dead: true } },
    { s1: { fret: 0, dead: true }, s2: { fret: 1, ghost: true, dead: true } },
  ]);
  toggleNoteFlagIn(doc, range, cursor, "dead");
  expect(notes().slice(0, 2)).toEqual([{ s3: { fret: 5 } }, { s1: { fret: 0 }, s2: { fret: 1, ghost: true } }]);
});

test("a selection of rests, or one whose beats are gone, changes nothing", () => {
  const { doc, cursor, range, ids, notes } = selected();
  const counted = { transactions: 0 };
  doc.on("afterTransaction", () => (counted.transactions += 1));
  toggleNoteFlagIn(doc, { ...range, anchorBeatId: "gone" }, cursor, "accent");
  const rest = appendBeat(doc, { ...cursor, beatId: ids[2]! });
  counted.transactions = 0;
  toggleNoteFlagIn(doc, { ...range, anchorBeatId: rest.beatId!, focusBeatId: rest.beatId! }, cursor, "accent");
  expect(counted.transactions).toBe(0);
  expect(notes().flatMap((beat) => Object.values(beat)).some((note) => note.accent)).toBe(false);
});
