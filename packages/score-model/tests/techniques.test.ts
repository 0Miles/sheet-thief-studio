// Turning the techniques of a note on and off (docs/spec/commands.md, 5.4): at the cursor, and
// over a selection.
import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  addPart,
  BEND_TYPES,
  bendCycle,
  bendStep,
  createScore,
  type Cursor,
  cursorAt,
  docToJson,
  flagsOf,
  HARMONICS,
  harmonicCycle,
  insertBars,
  insertBeat,
  type NoteJSON,
  type NotePlace,
  type NoteToggle,
  noteKeysAt,
  ON_OFF_TECHNIQUES,
  type OnOffTechnique,
  setFret,
  setNote,
  SLIDE_OUTS,
  slideInCycle,
  slideOutCycle,
  tieToggle,
  type Selection,
  toggleAt,
  techniqueToggle,
  toggleOnSelection,
  voiceIn,
} from "../src/index";
import { appendBeat, transactionsOf, undoEach, undoOf } from "./support";

const toggleNote = (doc: Y.Doc, cursor: Cursor, key: string, technique: OnOffTechnique) => toggleAt(doc, cursor, key, techniqueToggle(technique));
const toggleSelected = (doc: Y.Doc, selection: Selection, cursor: Cursor, technique: OnOffTechnique) => toggleOnSelection(doc, selection, cursor, techniqueToggle(technique));

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

test("at the cursor, a note reading leaves out is left alone: no technique key changes it", () => {
  const { doc, cursor } = guitar();
  setNote(doc, cursor, "s3", { fret: 99 });
  const transactions = transactionsOf(doc);
  for (const technique of ON_OFF_TECHNIQUES) toggleNote(doc, cursor, "s3", technique);
  expect(transactions.count).toBe(0);
  expect(storedNotes(doc, cursor).get("s3")).toEqual({ fret: 99 });
});

test("the keys of the notes on the cursor's line: its string on a fretted part, the pieces drawn on that line on drums, none yet on staves", () => {
  const { doc, cursor, barId } = guitar();
  expect(noteKeysAt(doc, cursor)).toEqual(["s3"]);
  const drums = addPart(doc, { name: "Drums", kind: "percussion" });
  const keys = addPart(doc, { name: "Keys", kind: "pitched" });
  // Snare, rim shot and kick; and p35, a kick the interface does not offer, which has no line.
  const hit = setNote(doc, insertBeat(doc, cursorAt(doc, drums, barId, 3)), "p38", {});
  for (const key of ["p91", "p36", "p35"]) setNote(doc, hit, key, {});
  expect(noteKeysAt(doc, hit).sort()).toEqual(["p38", "p91"]);
  expect(noteKeysAt(doc, { ...hit, line: 7 })).toEqual(["p36"]);
  expect(noteKeysAt(doc, { ...hit, line: 8 })).toEqual([]);
  expect(noteKeysAt(doc, { ...hit, at: "after" })).toEqual([]);
  expect(noteKeysAt(doc, cursorAt(doc, keys, barId, 4))).toEqual([]);
});

test("over a selection, a cycling technique takes every note to the one state decided for them all: the one after the first note's", () => {
  const { doc, cursor, notes, range } = selected();
  setNote(doc, cursor, "s3", { fret: 5, harmonic: "pinch" });
  setNote(doc, { ...cursor, beatId: range.focusBeatId }, "s1", { fret: 0, harmonic: "natural" });
  const harmonics = () => notes().slice(0, 2).flatMap((beat) => Object.values(beat).map((note) => note.harmonic ?? null));
  // The first note is pinch, the others natural and none: all go to artificial, the one after
  // pinch; not each to its own next, nor to natural for not sharing one.
  toggleOnSelection(doc, range, cursor, harmonicCycle);
  expect(harmonics()).toEqual(["artificial", "artificial", "artificial"]);
  toggleOnSelection(doc, range, cursor, harmonicCycle);
  expect(harmonics()).toEqual([null, null, null]);
  toggleOnSelection(doc, range, cursor, harmonicCycle);
  expect(harmonics()).toEqual(["natural", "natural", "natural"]);
  expect(notes()[2]).toEqual({ s3: { fret: 7 } });
});

/** As tie is at the cursor (#27): the fret of the note before, tied to it; where there is no note before, nothing changes. */
const tie: NoteToggle<true> = {
  decide: () => true,
  turn: (stored, _, { before }) => (before?.fret === undefined ? (stored ?? null) : { ...stored, fret: before.fret, tie: true }),
};

test("a toggle is told the note with the same key on the beat before, in the bar before when the beat is the first of its bar", () => {
  const { doc, barId, partId, cursor, notes } = selected();
  const [, nextBar] = docToJson(doc).bars.map((bar) => bar.id);
  setNote(doc, cursorAt(doc, partId, nextBar!), "s3", { fret: 9 });
  const told: [string, NoteJSON | null][] = [];
  const telling: NoteToggle<null> = {
    decide: () => null,
    turn(stored, _, place: NotePlace) {
      told.push([place.key, place.before ?? null]);
      return stored ?? null;
    },
  };
  const transactions = transactionsOf(doc);
  toggleOnSelection(doc, { kind: "bars", partId, anchorBarId: barId, focusBarId: nextBar! }, cursor, telling);
  // A toggle that gives back each note as stored changes nothing.
  expect(transactions.count).toBe(0);
  expect(told.sort()).toEqual(
    [
      ["s3", null],
      ["s1", null],
      ["s2", null],
      ["s3", null],
      ["s3", { fret: 7 }],
    ].sort(),
  );
  // At the cursor, in the append slot as on a beat: what a tie needs to take the fret of the note before.
  const first = cursorAt(doc, partId, nextBar!, 3);
  toggleAt(doc, { ...first, line: 2 }, "s2", tie);
  expect(notes(nextBar)).toEqual([{ s3: { fret: 9 } }]);
  toggleAt(doc, first, "s3", tie);
  expect(notes(nextBar)).toEqual([{ s3: { fret: 7, tie: true } }]);
  const appended = toggleAt(doc, { ...first, at: "after" }, "s3", tie);
  expect(notes(nextBar)).toEqual([{ s3: { fret: 7, tie: true } }, { s3: { fret: 7, tie: true } }]);
  expect(appended).toMatchObject({ at: "on" });
});

/** A guitar whose first bar holds frets 5, 7 and 9 on string 3, and whose second bar starts with 11; the beats of the first bar. */
function frets() {
  const { doc, barId, partId, cursor, notes } = guitar();
  let at = cursor;
  for (const fret of [7, 9]) {
    at = appendBeat(doc, at);
    setNote(doc, at, "s3", { fret });
  }
  const [, nextBar] = docToJson(doc).bars.map((bar) => bar.id);
  setNote(doc, cursorAt(doc, partId, nextBar!, 3), "s3", { fret: 11 });
  const ids = docToJson(doc).parts[0]!.content[barId]!["0:0"]!.map((beat) => beat.id);
  const string3 = (bar = barId) => notes(bar).map((beat) => beat.s3);
  return { doc, barId, nextBar: nextBar!, partId, cursor, ids, string3 };
}

test("over a selection, each note is told the note before as it has just become: a tie over beats in a row takes the fret of the first", () => {
  const { doc, barId, partId, cursor, ids, string3 } = frets();
  toggleOnSelection(doc, { kind: "beats", partId, barId, voice: "0:0", anchorBeatId: ids[1]!, focusBeatId: ids[2]! }, cursor, tie);
  expect(string3()).toEqual([{ fret: 5 }, { fret: 5, tie: true }, { fret: 5, tie: true }]);
});

test("over a bar range, what a note has just become is carried on to the first beat of the next bar", () => {
  const { doc, barId, nextBar, partId, cursor, string3 } = frets();
  toggleOnSelection(doc, { kind: "bars", partId, anchorBarId: barId, focusBarId: nextBar }, cursor, tie);
  expect(string3()).toEqual([{ fret: 5 }, { fret: 5, tie: true }, { fret: 5, tie: true }]);
  expect(string3(nextBar)).toEqual([{ fret: 5, tie: true }]);
});

test("over a selection, a beat reading leaves out is neither seen nor changed, and the note before skips it", () => {
  const { doc, barId, partId, cursor, ids, string3 } = frets();
  // A note value there is none of: the beat of fret 7 cannot be read, so the members do not see it.
  const unreadable = voiceIn(doc, cursor)!.get(1);
  doc.transact(() => unreadable.set("value", 3));
  const range: Selection = { kind: "beats", partId, barId, voice: "0:0", anchorBeatId: ids[0]!, focusBeatId: ids[2]! };
  toggleOnSelection(doc, range, cursor, tie);
  expect(string3()).toEqual([{ fret: 5 }, { fret: 5, tie: true }]);
  expect((unreadable.get("notes") as Y.Map<unknown>).get("s3")).toEqual({ fret: 7 });
  // Off is off when every note seen has it: the unreadable beat's note does not count.
  toggleSelected(doc, range, cursor, "ghost");
  toggleSelected(doc, range, cursor, "ghost");
  expect(string3()).toEqual([{ fret: 5 }, { fret: 5, tie: true }]);
  expect((unreadable.get("notes") as Y.Map<unknown>).get("s3")).toEqual({ fret: 7 });
});

// Tie (docs/spec/commands.md, 5.4): adding it takes the fret of the note before; that is what the
// command does, not a repair.
const toggleTie = (doc: Y.Doc, cursor: Cursor, key: string) => toggleAt(doc, cursor, key, tieToggle);
const danglingTies = (doc: Y.Doc) => flagsOf(docToJson(doc)).filter((flag) => flag.kind === "danglingTie");

test("a tie takes the fret of the note before on its string, in its bar or the bar before, one undo step; again, it goes and the fret stays", () => {
  const { doc, partId, cursor, notes } = guitar();
  const [, nextBar] = docToJson(doc).bars.map((bar) => bar.id);
  const second = appendBeat(doc, cursor);
  setFret(doc, second, 7);
  const opening = { ...setFret(doc, cursorAt(doc, partId, nextBar!, 3), 2), line: 3 };
  const undo = undoOf(doc);
  expect(toggleTie(doc, second, "s3")).toEqual(second);
  expect(notes()).toEqual([{ s3: { fret: 5 } }, { s3: { fret: 5, tie: true } }]);
  toggleTie(doc, opening, "s3");
  expect(notes(nextBar)).toEqual([{ s3: { fret: 5, tie: true } }]);
  expect(danglingTies(doc)).toEqual([]);
  toggleTie(doc, opening, "s3");
  expect(notes(nextBar)).toEqual([{ s3: { fret: 5 } }]);
  undo.undo();
  expect(notes(nextBar)).toEqual([{ s3: { fret: 5, tie: true } }]);
  undo.undo();
  expect(notes(nextBar)).toEqual([{ s3: { fret: 2 } }]);
  undo.undo();
  expect(notes()).toEqual([{ s3: { fret: 5 } }, { s3: { fret: 7 } }]);
  expect(undo.canUndo()).toBe(false);
});

test("with no note before it, the tie is added all the same, the fret kept, and it is a dangling tie", () => {
  const { doc, barId, partId, cursor, notes } = guitar();
  toggleTie(doc, cursor, "s3");
  expect(notes()).toEqual([{ s3: { fret: 5, tie: true } }]);
  const second = appendBeat(doc, cursor);
  setNote(doc, second, "s2", { fret: 4 });
  toggleTie(doc, { ...second, line: 2 }, "s2");
  expect(notes()[1]).toEqual({ s2: { fret: 4, tie: true } });
  expect(danglingTies(doc)).toEqual([
    { kind: "danglingTie", partId, barId, voice: "0:0", beatId: cursor.beatId, noteKey: "s3" },
    { kind: "danglingTie", partId, barId, voice: "0:0", beatId: second.beatId, noteKey: "s2" },
  ]);
});

test("on an empty string, a tie makes the note before's fret there, tied; with no note before, it makes nothing", () => {
  const { doc, cursor, notes } = guitar();
  const second = appendBeat(doc, cursor);
  toggleTie(doc, second, "s3");
  expect(notes()[1]).toEqual({ s3: { fret: 5, tie: true } });
  const transactions = transactionsOf(doc);
  toggleTie(doc, { ...second, line: 1 }, "s1");
  expect(transactions.count).toBe(0);
  // In the append slot, as a digit does: a new beat, the cursor on it.
  const appended = toggleTie(doc, { ...second, at: "after" }, "s3");
  expect(notes()).toEqual([{ s3: { fret: 5 } }, { s3: { fret: 5, tie: true } }, { s3: { fret: 5, tie: true } }]);
  expect(appended).toMatchObject({ at: "on" });
});

test("over a selection, a tie goes on every note unless all have it, each taking the fret of the note before it as it has just become; it makes no notes", () => {
  const { doc, barId, partId, cursor, notes } = guitar();
  let at = cursor;
  for (const fret of [7, 9]) {
    at = appendBeat(doc, at);
    setNote(doc, at, "s3", { fret });
  }
  at = appendBeat(doc, at);
  setNote(doc, at, "s1", { fret: 3 });
  const ids = docToJson(doc).parts[0]!.content[barId]!["0:0"]!.map((beat) => beat.id);
  const range: Selection = { kind: "beats", partId, barId, voice: "0:0", anchorBeatId: ids[0]!, focusBeatId: ids[3]! };
  toggleOnSelection(doc, range, cursor, tieToggle);
  expect(notes()).toEqual([{ s3: { fret: 5, tie: true } }, { s3: { fret: 5, tie: true } }, { s3: { fret: 5, tie: true } }, { s1: { fret: 3, tie: true } }]);
  toggleOnSelection(doc, range, cursor, tieToggle);
  expect(notes()).toEqual([{ s3: { fret: 5 } }, { s3: { fret: 5 } }, { s3: { fret: 5 } }, { s1: { fret: 3 } }]);
});

test("a dead note without a fret before it gives no fret: the tie goes on a note there, none is made", () => {
  const { doc, cursor, notes } = guitar();
  setNote(doc, cursor, "s3", { dead: true });
  const second = appendBeat(doc, cursor);
  const transactions = transactionsOf(doc);
  toggleTie(doc, second, "s3");
  expect(transactions.count).toBe(0);
  setNote(doc, second, "s3", { fret: 2 });
  toggleTie(doc, second, "s3");
  expect(notes()[1]).toEqual({ s3: { fret: 2, tie: true } });
});

test("on a pitched part, a tie on an empty line makes the note before's pitch there, as it is spelled", () => {
  const doc = new Y.Doc();
  createScore(doc, "Demo");
  const [barId] = insertBars(doc, { after: null, count: 1 });
  const partId = addPart(doc, { name: "Voice", kind: "pitched" });
  const first = setNote(doc, cursorAt(doc, partId, barId!), "n61", { spell: "Db", staccato: true });
  const second = appendBeat(doc, first);
  toggleAt(doc, second, "n61", tieToggle);
  expect(docToJson(doc).parts[0]!.content[barId!]!["0:0"]!.map((beat) => beat.notes)).toEqual([{ n61: { spell: "Db", staccato: true } }, { n61: { spell: "Db", tie: true } }]);
  expect(flagsOf(docToJson(doc))).toEqual([{ kind: "underfull", partId, barId, voice: "0:0" }]);
});

// Links (#27; docs/spec/commands.md, 5.4): legato is on or off; a slide out and a slide in step
// through their kinds and back to none.
test("legato turns on and off on the note of the cursor's string, and makes no note on an empty one", () => {
  const { doc, cursor, notes } = guitar();
  toggleNote(doc, cursor, "s3", "legato");
  expect(notes()).toEqual([{ s3: { fret: 5, legato: true } }]);
  toggleNote(doc, cursor, "s3", "legato");
  expect(notes()).toEqual([{ s3: { fret: 5 } }]);
  const transactions = transactionsOf(doc);
  toggleNote(doc, { ...cursor, line: 1 }, "s1", "legato");
  expect(transactions.count).toBe(0);
});

test("a slide out steps through legato, shift, out up and out down, back to none, one undo step each, keeping what else the note holds", () => {
  const { doc, cursor, notes } = guitar();
  setNote(doc, cursor, "s3", { fret: 5, ghost: true });
  const undo = undoOf(doc);
  const slides = [1, 2, 3, 4, 5].map(() => {
    toggleAt(doc, cursor, "s3", slideOutCycle);
    return notes()[0]!.s3!.slideOut ?? null;
  });
  expect(slides).toEqual(["legato", "shift", "outUp", "outDown", null]);
  expect(notes()).toEqual([{ s3: { fret: 5, ghost: true } }]);
  undoEach(undo, () => notes()[0]!.s3!, [{}, ...SLIDE_OUTS.map((slideOut) => ({ slideOut }))], { fret: 5, ghost: true });
  // On an empty string it makes no note.
  const transactions = transactionsOf(doc);
  toggleAt(doc, { ...cursor, line: 1 }, "s1", slideOutCycle);
  toggleAt(doc, { ...cursor, line: 1 }, "s1", slideInCycle);
  expect(transactions.count).toBe(0);
});

test("a slide in steps through in from below and in from above, back to none, one undo step each", () => {
  const { doc, cursor, notes } = guitar();
  const undo = undoOf(doc);
  const slides = [1, 2, 3].map(() => {
    toggleAt(doc, cursor, "s3", slideInCycle);
    return notes()[0]!.s3!.slideIn ?? null;
  });
  expect(slides).toEqual(["inBelow", "inAbove", null]);
  expect(notes()).toEqual([{ s3: { fret: 5 } }]);
  undoEach(undo, () => notes()[0]!.s3!, [{}, { slideIn: "inBelow" }, { slideIn: "inAbove" }], { fret: 5 });
});

test("over a selection, a slide takes every note to the kind after the first note's, as the beat markings do", () => {
  const { doc, cursor, notes, range } = selected();
  setNote(doc, cursor, "s3", { fret: 5, slideOut: "shift", slideIn: "inAbove" });
  setNote(doc, { ...cursor, beatId: range.focusBeatId }, "s1", { fret: 0, slideOut: "legato", slideIn: "inBelow" });
  const slides = (field: "slideOut" | "slideIn") => notes().slice(0, 2).flatMap((beat) => Object.values(beat).map((note) => note[field] ?? null));
  // The first note slides out shift, the others legato and none: all go to out up, the one after
  // shift; not each to its own next, nor to legato for not sharing one.
  toggleOnSelection(doc, range, cursor, slideOutCycle);
  expect(slides("slideOut")).toEqual(["outUp", "outUp", "outUp"]);
  toggleOnSelection(doc, range, cursor, slideOutCycle);
  expect(slides("slideOut")).toEqual(["outDown", "outDown", "outDown"]);
  toggleOnSelection(doc, range, cursor, slideOutCycle);
  expect(slides("slideOut")).toEqual([null, null, null]);
  toggleOnSelection(doc, range, cursor, slideOutCycle);
  expect(slides("slideOut")).toEqual(["legato", "legato", "legato"]);
  // The first note slides in from above, the last of the kinds: all go to none, not to from below.
  toggleOnSelection(doc, range, cursor, slideInCycle);
  expect(slides("slideIn")).toEqual([null, null, null]);
  expect(notes()[2]).toEqual({ s3: { fret: 7 } });
});

test("at the cursor, on a beat reading leaves out, no technique key changes it, though its notes could be read", () => {
  const { doc, cursor } = guitar();
  const beat = voiceIn(doc, cursor)!.get(0);
  doc.transact(() => beat.set("value", 3));
  const transactions = transactionsOf(doc);
  for (const technique of ON_OFF_TECHNIQUES) toggleNote(doc, cursor, "s3", technique);
  toggleAt(doc, cursor, "s3", slideOutCycle);
  toggleAt(doc, cursor, "s3", harmonicCycle);
  toggleAt(doc, { ...cursor, line: 1 }, "s1", tieToggle);
  expect(transactions.count).toBe(0);
  expect(storedNotes(doc, cursor).toJSON()).toEqual({ s3: { fret: 5 } });
});

// Bend (#28; docs/spec/commands.md, 5.4): Shift+B steps through the four preset shapes and back to
// none, a new bend of two semitones; Shift+↑ and Shift+↓ take a semitone more or less, 1 to 4.
test("a bend steps through bend, bend and release, pre-bend and pre-bend and release, back to none, one undo step each, a new one of 2 semitones", () => {
  const { doc, cursor, notes } = guitar();
  setNote(doc, cursor, "s3", { fret: 7, ghost: true });
  const undo = undoOf(doc);
  const bends = [1, 2, 3, 4, 5].map(() => {
    toggleAt(doc, cursor, "s3", bendCycle);
    return notes()[0]!.s3!.bend ?? null;
  });
  expect(bends).toEqual([
    { type: "bend", semitones: 2 },
    { type: "bendRelease", semitones: 2 },
    { type: "preBend", semitones: 2 },
    { type: "preBendRelease", semitones: 2 },
    null,
  ]);
  expect(notes()).toEqual([{ s3: { fret: 7, ghost: true } }]);
  undoEach(undo, () => notes()[0]!.s3!, [{}, ...BEND_TYPES.map((type) => ({ bend: { type, semitones: 2 } }))], { fret: 7, ghost: true });
});

test("a bend's semitones go up and down one at a time, from 1 to 4, kept when its shape changes, one undo step each", () => {
  const { doc, cursor, notes } = guitar();
  toggleAt(doc, cursor, "s3", bendCycle);
  const undo = undoOf(doc);
  const semitones = ([1, 1, 1, -1, -1, -1, -1] as const).map((step) => {
    toggleAt(doc, cursor, "s3", bendStep(step));
    return notes()[0]!.s3!.bend!.semitones;
  });
  expect(semitones).toEqual([3, 4, 4, 3, 2, 1, 1]);
  toggleAt(doc, cursor, "s3", bendCycle);
  expect(notes()).toEqual([{ s3: { fret: 5, bend: { type: "bendRelease", semitones: 1 } } }]);
  // The steps that went past 1 or 4 wrote nothing: no undo step of their own.
  undoEach(undo, () => notes()[0]!.s3!, [2, 3, 4, 3, 2, 1].map((semitones) => ({ bend: { type: "bend", semitones } })), { fret: 5 });
});

test("the semitones of a note with no bend, or of no note, stay as they are: nothing is written", () => {
  const { doc, cursor } = guitar();
  const transactions = transactionsOf(doc);
  toggleAt(doc, cursor, "s3", bendStep(1));
  toggleAt(doc, cursor, "s3", bendStep(-1));
  toggleAt(doc, { ...cursor, line: 1 }, "s1", bendStep(1));
  toggleAt(doc, { ...cursor, line: 1 }, "s1", bendCycle);
  expect(transactions.count).toBe(0);
});

test("over a selection, a bend takes every note to the shape after the first note's, each keeping its semitones, and the semitones of each go a step", () => {
  const { doc, cursor, notes, range } = selected();
  setNote(doc, cursor, "s3", { fret: 5, bend: { type: "preBend", semitones: 3 } });
  setNote(doc, { ...cursor, beatId: range.focusBeatId }, "s1", { fret: 0, bend: { type: "bend", semitones: 4 } });
  /** The bend of each note of the two beats selected, by its string. */
  const bends = <T>(of: (bend: NonNullable<NoteJSON["bend"]>) => T) => notes().slice(0, 2).map((beat) => Object.fromEntries(Object.entries(beat).map(([key, note]) => [key, note.bend && of(note.bend)])));
  // The first note is a pre-bend, the others a bend and none: all go to pre-bend and release, the
  // one after pre-bend; not each to its own next, nor to bend for not sharing one.
  toggleOnSelection(doc, range, cursor, bendCycle);
  expect(bends((bend) => bend)).toEqual([
    { s3: { type: "preBendRelease", semitones: 3 } },
    { s1: { type: "preBendRelease", semitones: 4 }, s2: { type: "preBendRelease", semitones: 2 } },
  ]);
  toggleOnSelection(doc, range, cursor, bendStep(1));
  expect(bends((bend) => bend.semitones)).toEqual([{ s3: 4 }, { s1: 4, s2: 3 }]);
  toggleOnSelection(doc, range, cursor, bendCycle);
  expect(bends((bend) => bend.type)).toEqual([{ s3: undefined }, { s1: undefined, s2: undefined }]);
  toggleOnSelection(doc, range, cursor, bendCycle);
  expect(bends((bend) => bend)).toEqual([
    { s3: { type: "bend", semitones: 2 } },
    { s1: { type: "bend", semitones: 2 }, s2: { type: "bend", semitones: 2 } },
  ]);
  expect(notes()[2]).toEqual({ s3: { fret: 7 } });
});

// Harmonic (#29; docs/spec/commands.md, 5.4): Shift+N steps through natural, pinch and artificial,
// back to none.
test("a harmonic steps through natural, pinch and artificial, back to none, one undo step each, keeping what else the note holds", () => {
  const { doc, cursor, notes } = guitar();
  setNote(doc, cursor, "s3", { fret: 12, letRing: true });
  const undo = undoOf(doc);
  const harmonics = [1, 2, 3, 4].map(() => {
    toggleAt(doc, cursor, "s3", harmonicCycle);
    return notes()[0]!.s3!.harmonic ?? null;
  });
  expect(harmonics).toEqual(["natural", "pinch", "artificial", null]);
  expect(notes()).toEqual([{ s3: { fret: 12, letRing: true } }]);
  undoEach(undo, () => notes()[0]!.s3!, [{}, ...HARMONICS.map((harmonic) => ({ harmonic }))], { fret: 12, letRing: true });
  // On an empty string it makes no note.
  const transactions = transactionsOf(doc);
  toggleAt(doc, { ...cursor, line: 1 }, "s1", harmonicCycle);
  expect(transactions.count).toBe(0);
});
