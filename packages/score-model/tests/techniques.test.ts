// Turning the techniques of a note on and off (docs/spec/commands.md, 5.4): at the cursor, and
// over a selection.
import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  addPart,
  createScore,
  type Cursor,
  cursorAt,
  docToJson,
  insertBars,
  ON_OFF_TECHNIQUES,
  onOffToggle,
  type OnOffTechnique,
  setFret,
  setNote,
  type Selection,
  toggleAt,
  toggleOnSelection,
  voiceIn,
} from "../src/index";
import { appendBeat, transactionsOf, undoOf } from "./support";

const toggleNote = (doc: Y.Doc, cursor: Cursor, key: string, technique: OnOffTechnique) => toggleAt(doc, cursor, key, onOffToggle(technique));
const toggleSelected = (doc: Y.Doc, selection: Selection, cursor: Cursor, technique: OnOffTechnique) => toggleOnSelection(doc, selection, cursor, onOffToggle(technique));

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

/** The notes of the first beat of the cursor's voice as stored, fields reading leaves out among them. */
const storedNotes = (doc: Y.Doc, cursor: Cursor) => voiceIn(doc, cursor)!.get(0).get("notes") as Y.Map<unknown>;

test.each(ON_OFF_TECHNIQUES)("%s turns on and off on the note of the cursor's string, one undo step each, keeping its fret", (technique) => {
  const { doc, cursor, notes } = guitar();
  const undo = undoOf(doc);
  expect(toggleNote(doc, cursor, "s3", technique)).toEqual(cursor);
  expect(notes()).toEqual([{ s3: { fret: 5, [technique]: true } }]);
  toggleNote(doc, cursor, "s3", technique);
  expect(notes()).toEqual([{ s3: { fret: 5 } }]);
  undo.undo();
  expect(notes()).toEqual([{ s3: { fret: 5, [technique]: true } }]);
  undo.undo();
  expect(notes()).toEqual([{ s3: { fret: 5 } }]);
});

test("a toggle keeps what else the note holds, fields this version does not know among them", () => {
  const { doc, cursor, notes } = guitar();
  setNote(doc, cursor, "s3", { fret: 5, ghost: true, futureField: 1 } as never);
  toggleNote(doc, cursor, "s3", "accent");
  toggleNote(doc, cursor, "s3", "ghost");
  expect(storedNotes(doc, cursor).get("s3")).toEqual({ fret: 5, accent: true, futureField: 1 });
  expect(notes()).toEqual([{ s3: { fret: 5, accent: true } }]);
});

test("on a string with no note, dead makes a dead note without a fret, and again takes it away; the other techniques do nothing", () => {
  const { doc, cursor, notes } = guitar();
  const empty = { ...cursor, line: 1 };
  const transactions = transactionsOf(doc);
  for (const technique of ON_OFF_TECHNIQUES.filter((each) => each !== "dead")) toggleNote(doc, empty, "s1", technique);
  expect(transactions.count).toBe(0);
  expect(notes()).toEqual([{ s3: { fret: 5 } }]);
  toggleNote(doc, empty, "s1", "dead");
  expect(notes()).toEqual([{ s3: { fret: 5 }, s1: { dead: true } }]);
  toggleNote(doc, empty, "s1", "dead");
  expect(notes()).toEqual([{ s3: { fret: 5 } }]);
});

test("dead on a fretted note keeps its fret, and off again leaves the note as it was", () => {
  const { doc, cursor, notes } = guitar();
  toggleNote(doc, cursor, "s3", "dead");
  expect(notes()).toEqual([{ s3: { fret: 5, dead: true } }]);
  toggleNote(doc, cursor, "s3", "dead");
  expect(notes()).toEqual([{ s3: { fret: 5 } }]);
});

test("dead in the append slot makes a beat there with a dead note, and the cursor moves onto it", () => {
  const { doc, cursor, notes } = guitar();
  const slot: Cursor = { ...cursor, at: "after" };
  expect(toggleNote(doc, slot, "s3", "ghost")).toEqual(slot);
  expect(notes()).toHaveLength(1);
  const next = toggleNote(doc, slot, "s3", "dead");
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

test("over a beat range, a technique goes on every note unless all of them have it, then off all of them, in one undo step", () => {
  const { doc, cursor, notes, range, bassNotes } = selected();
  const undo = undoOf(doc);
  expect(toggleSelected(doc, range, cursor, "ghost")).toEqual(cursor);
  expect(notes()).toEqual([{ s3: { fret: 5, ghost: true } }, { s1: { fret: 0, ghost: true }, s2: { fret: 1, ghost: true } }, { s3: { fret: 7 } }]);
  toggleSelected(doc, range, cursor, "ghost");
  expect(notes()).toEqual([{ s3: { fret: 5 } }, { s1: { fret: 0 }, s2: { fret: 1 } }, { s3: { fret: 7 } }]);
  undo.undo();
  expect(notes()[1]).toEqual({ s1: { fret: 0, ghost: true }, s2: { fret: 1, ghost: true } });
  undo.undo();
  expect(notes()[1]).toEqual({ s1: { fret: 0 }, s2: { fret: 1, ghost: true } });
  expect(bassNotes()).toEqual([{ s1: { fret: 3 } }]);
});

test("over a bar range, a technique goes on every note of the part in those bars, in every voice", () => {
  const { doc, barId, partId, cursor, notes, bassNotes } = selected();
  const [, nextBar] = docToJson(doc).bars.map((bar) => bar.id);
  setFret(doc, { ...cursorAt(doc, partId, barId, 2), voice: "0:1", beatId: null, at: "after" }, 9);
  setFret(doc, cursorAt(doc, partId, nextBar!, 4), 2);
  toggleSelected(doc, { kind: "bars", partId, anchorBarId: nextBar!, focusBarId: barId }, cursor, "palmMute");
  expect(notes().flatMap((beat) => Object.values(beat))).toEqual([5, 0, 1, 7].map((fret) => expect.objectContaining({ fret, palmMute: true })));
  expect(notes(nextBar)).toEqual([{ s4: { fret: 2, palmMute: true } }]);
  expect(docToJson(doc).parts[0]!.content[barId]!["0:1"]!.map((beat) => beat.notes)).toEqual([{ s2: { fret: 9, palmMute: true } }]);
  expect(bassNotes()).toEqual([{ s1: { fret: 3 } }]);
});

test("over a selection, dead makes no notes on empty strings, and off takes away the dead notes that have no fret", () => {
  const { doc, cursor, notes, range } = selected();
  setNote(doc, cursor, "s6", { dead: true });
  toggleSelected(doc, range, cursor, "dead");
  expect(notes().slice(0, 2)).toEqual([
    { s3: { fret: 5, dead: true }, s6: { dead: true } },
    { s1: { fret: 0, dead: true }, s2: { fret: 1, ghost: true, dead: true } },
  ]);
  toggleSelected(doc, range, cursor, "dead");
  expect(notes().slice(0, 2)).toEqual([{ s3: { fret: 5 } }, { s1: { fret: 0 }, s2: { fret: 1, ghost: true } }]);
});

test("a selection of rests, or one whose beats are gone, changes nothing", () => {
  const { doc, cursor, range, ids, notes } = selected();
  const transactions = transactionsOf(doc);
  toggleSelected(doc, { ...range, anchorBeatId: "gone" }, cursor, "accent");
  const rest = appendBeat(doc, { ...cursor, beatId: ids[2]! });
  transactions.count = 0;
  toggleSelected(doc, { ...range, anchorBeatId: rest.beatId!, focusBeatId: rest.beatId! }, cursor, "accent");
  expect(transactions.count).toBe(0);
  expect(notes().flatMap((beat) => Object.values(beat)).some((note) => note.accent)).toBe(false);
});

test("over a selection, notes reading leaves out neither count nor change: off is off when every note the members see has it", () => {
  const { doc, cursor, range, notes } = selected();
  toggleSelected(doc, range, cursor, "ghost");
  // A fret past the last one, and a drum piece on a guitar: neither can be read, so neither is seen.
  setNote(doc, cursor, "s4", { fret: 99 });
  setNote(doc, cursor, "p38", {});
  const stored = storedNotes(doc, cursor);
  toggleSelected(doc, range, cursor, "ghost");
  expect(notes().slice(0, 2)).toEqual([{ s3: { fret: 5 } }, { s1: { fret: 0 }, s2: { fret: 1 } }]);
  expect([stored.get("s4"), stored.get("p38")]).toEqual([{ fret: 99 }, {}]);
  toggleSelected(doc, range, cursor, "dead");
  expect([stored.get("s4"), stored.get("p38")]).toEqual([{ fret: 99 }, {}]);
});
