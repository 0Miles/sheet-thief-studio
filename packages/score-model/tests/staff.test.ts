// Typing on a staff (docs/spec/commands.md, 5.1, 5.2 and 5.8): a letter enters a note in the
// octave nearest the cursor, spelled by the key; ] and [ move the notes of the cursor's line a
// semitone, Shift+↑ and Shift+↓ an octave; Delete takes them off. Notes are keyed by pitch.
import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  addPart,
  createScore,
  type Cursor,
  cursorAt,
  deleteNote,
  docToJson,
  enterNote,
  insertBars,
  insertBeat,
  type KeySignature,
  moveNotesByOctave,
  moveNotesBySemitone,
  type NoteJSON,
  noteKeysAt,
  setClef,
  setKeySig,
  setNote,
  voiceIn,
} from "../src/index";
import { transactionsOf, undoOf } from "./support";

/** A keyboard part (treble and bass staves) in two empty bars, the cursor in the append slot of the first bar's treble staff, on its middle line (B4). */
function keyboard(keySig?: KeySignature) {
  const doc = new Y.Doc();
  createScore(doc, "Demo");
  const barIds = insertBars(doc, { after: null, count: 2 });
  const partId = addPart(doc, { name: "Keys", kind: "pitched", staves: [{ clef: "treble" }, { clef: "bass" }] });
  const start = cursorAt(doc, partId, barIds[0]!, 4);
  if (keySig) setKeySig(doc, start, keySig);
  const notes = (voice = "0:0", bar = 0) => docToJson(doc).parts[0]!.content[barIds[bar]!]![voice]!.map((beat) => beat.notes);
  /** A beat holding `held`, the cursor on it at `line`. */
  const beatWith = (held: Record<string, NoteJSON>, line = 4): Cursor => {
    const on = { ...insertBeat(doc, start), line };
    for (const [key, note] of Object.entries(held)) setNote(doc, on, key, note);
    return on;
  };
  return { doc, start, notes, beatWith, barIds, partId };
}

test("a letter in the append slot makes a beat with the note nearest the cursor's position, spelled, the cursor on it and on the note's position; one transaction", () => {
  const { doc, start, notes } = keyboard();
  const transactions = transactionsOf(doc);
  const cursor = enterNote(doc, start, "C");
  expect(transactions.count).toBe(1);
  // From B4, the nearest C is C5, on the third space from the top.
  expect(notes()).toEqual([{ n72: { spell: "C" } }]);
  expect(cursor).toMatchObject({ at: "on", line: 3 });
  expect(cursor.beatId).toBe(voiceIn(doc, cursor)!.get(0).get("id"));
});

test("a letter on a beat that has notes adds one to the chord, the cursor staying on the beat", () => {
  const { doc, start, notes } = keyboard();
  let cursor = enterNote(doc, start, "C");
  cursor = enterNote(doc, cursor, "E");
  cursor = enterNote(doc, cursor, "G");
  expect(notes()).toEqual([{ n72: { spell: "C" }, n76: { spell: "E" }, n79: { spell: "G" } }]);
  expect(cursor).toMatchObject({ at: "on", line: -1 });
});

test("the key in force in the bar gives the sharps and flats: F in D major is F♯, B in B♭ major is B♭", () => {
  const sharps = keyboard({ fifths: 2, mode: "major" });
  enterNote(sharps.doc, sharps.start, "F");
  expect(sharps.notes()).toEqual([{ n66: { spell: "F#" } }]);
  const flats = keyboard({ fifths: -2, mode: "major" });
  enterNote(flats.doc, flats.start, "B");
  expect(flats.notes()).toEqual([{ n70: { spell: "Bb" } }]);
  // The key of the first bar goes on into the second.
  const next = cursorAt(flats.doc, flats.partId, flats.barIds[1]!, 4);
  enterNote(flats.doc, next, "E");
  expect(flats.notes("0:0", 1)).toEqual([{ n75: { spell: "Eb" } }]);
});

test("on the bass staff the letter is entered in the bass clef's octave", () => {
  const { doc, partId, barIds, notes } = keyboard();
  // The bass staff's middle line is D3: the nearest C is C3.
  const cursor = enterNote(doc, { ...cursorAt(doc, partId, barIds[0]!, 4), voice: "1:0" }, "C");
  expect(notes("1:0")).toEqual([{ n48: { spell: "C" } }]);
  expect(cursor.line).toBe(5);
});

test("a note of the same pitch as the one entered is replaced: C♯ then D♭ is one note, spelled D♭, keeping what else it held", () => {
  const { doc, beatWith, notes } = keyboard({ fifths: -5, mode: "major" });
  // C♯4 with an accent; in D♭ major, D is D♭: the same key, n61.
  const cursor = beatWith({ n61: { spell: "C#", accent: true } }, 10);
  enterNote(doc, cursor, "D");
  expect(notes()).toEqual([{ n61: { spell: "Db", accent: true } }]);
  // Entered again as it is: nothing is written.
  const transactions = transactionsOf(doc);
  enterNote(doc, { ...cursor, line: 9 }, "D");
  expect(transactions.count).toBe(0);
});

test("the cursor goes to the entered note's position, held to the positions the cursor has", () => {
  const { doc, start } = keyboard();
  // Two ledger lines above the treble staff is C6: the nearest E is E6, above the cursor's range.
  expect(enterNote(doc, { ...start, line: -4 }, "E").line).toBe(-4);
});

test("the notes of the cursor's line are those drawn there: C and C♯ on C's, D♭ on D's, by the clef of the staff", () => {
  const { doc, beatWith, partId } = keyboard({ fifths: -1, mode: "major" });
  // C4, C♯4, D♭4 is n61 too, so another pitch: E♭4 spelled as D♯, and n63 unspelled, which the key spells E♭.
  const cursor = beatWith({ n60: { spell: "C" }, n61: { spell: "C#" }, n62: {}, n63: { spell: "D#" } }, 10);
  expect(noteKeysAt(doc, cursor).sort()).toEqual(["n60", "n61"]);
  expect(noteKeysAt(doc, { ...cursor, line: 9 }).sort()).toEqual(["n62", "n63"]);
  // A spelling of another pitch is drawn as the key spells it: B♭ in F major.
  setNote(doc, cursor, "n70", { spell: "C" });
  expect(noteKeysAt(doc, { ...cursor, line: 4 })).toEqual(["n70"]);
  // A note reading leaves out is drawn nowhere.
  setNote(doc, cursor, "n64", { fret: 3 } as NoteJSON);
  expect(noteKeysAt(doc, { ...cursor, line: 8 })).toEqual([]);
  // In the bass clef, C4 is on the first ledger line above the staff.
  setClef(doc, partId, 0, "bass");
  expect(noteKeysAt(doc, { ...cursor, line: -2 }).sort()).toEqual(["n60", "n61"]);
});

test("] raises the notes of the cursor's line a semitone, spelled sharp on a black key, keeping what else they hold; [ lowers them, spelled flat; one transaction each", () => {
  const { doc, beatWith, notes } = keyboard();
  const undo = undoOf(doc);
  const cursor = beatWith({ n60: { spell: "C", accent: true }, n67: { spell: "G" } }, 10);
  const transactions = transactionsOf(doc);
  let moved = moveNotesBySemitone(doc, cursor, 1);
  expect(transactions.count).toBe(1);
  expect(notes()).toEqual([{ n61: { spell: "C#", accent: true }, n67: { spell: "G" } }]);
  expect(moved.line).toBe(10);
  moved = moveNotesBySemitone(doc, moved, -1);
  expect(notes()).toEqual([{ n60: { spell: "C", accent: true }, n67: { spell: "G" } }]);
  // Down from C is B, a white key: natural, on B's position, where the cursor goes.
  moved = moveNotesBySemitone(doc, moved, -1);
  expect(notes()).toEqual([{ n59: { spell: "B", accent: true }, n67: { spell: "G" } }]);
  expect(moved.line).toBe(11);
  expect(moveNotesBySemitone(doc, moved, -1).line).toBe(11);
  expect(notes()).toEqual([{ n58:{ spell: "Bb", accent: true }, n67: { spell: "G" } }]);
  for (const before of [{ n59: { spell: "B", accent: true } }, { n60: { spell: "C", accent: true } }, { n61: { spell: "C#", accent: true } }, { n60: { spell: "C", accent: true } }]) {
    undo.undo();
    expect(notes()).toEqual([{ ...before, n67: { spell: "G" } }]);
  }
});

test("] on a line of two notes moves both, in one transaction; the cursor follows the lower one", () => {
  const { doc, beatWith, notes } = keyboard();
  const cursor = beatWith({ n62: { spell: "D" }, n63: { spell: "D#" } }, 9);
  const moved = moveNotesBySemitone(doc, cursor, 1);
  expect(notes()).toEqual([{ n63: { spell: "D#" }, n64: { spell: "E" } }]);
  expect(moved.line).toBe(9);
});

test("a note moved onto the pitch of another note of the beat replaces it: the later wins", () => {
  const { doc, beatWith, notes } = keyboard();
  // E4 and F4; ] on E's line makes the E an F.
  const cursor = beatWith({ n64: { spell: "E", staccato: true }, n65: { spell: "F", accent: true } }, 8);
  moveNotesBySemitone(doc, cursor, 1);
  expect(notes()).toEqual([{ n65: { spell: "F", staccato: true } }]);
});

test("Shift+↑ and Shift+↓ move the notes of the line an octave, keeping their spelling; the cursor goes 7 positions with them", () => {
  const { doc, beatWith, notes } = keyboard();
  const cursor = beatWith({ n61: { spell: "Db", tie: true }, n64: { spell: "E" } }, 9);
  const transactions = transactionsOf(doc);
  const up = moveNotesByOctave(doc, cursor, 1);
  expect(transactions.count).toBe(1);
  expect(notes()).toEqual([{ n73: { spell: "Db", tie: true }, n64: { spell: "E" } }]);
  expect(up.line).toBe(2);
  const down = moveNotesByOctave(doc, moveNotesByOctave(doc, up, -1), -1);
  expect(notes()).toEqual([{ n49: { spell: "Db", tie: true }, n64: { spell: "E" } }]);
  // D♭3 is on position 16, below the cursor's range: the cursor stops at its last position.
  expect(down.line).toBe(12);
  // A note without a spelling stays without one.
  const plain = beatWith({ n66: {} }, 7);
  moveNotesByOctave(doc, plain, 1);
  expect(notes()[0]).toEqual({ n78: {} });
});

test("an octave that would take a note of the line past 0 to 127 moves none of them", () => {
  const { doc, beatWith, notes } = keyboard();
  const cursor = beatWith({ n120: { spell: "C" }, n122: { spell: "D" } }, -10);
  const transactions = transactionsOf(doc);
  // C9 and D9 are far above the staff: on a cursor at the position of C9.
  const c9 = { ...cursor, line: 3 - 4 * 7 };
  expect(noteKeysAt(doc, c9)).toEqual(["n120"]);
  expect(moveNotesByOctave(doc, c9, 1)).toEqual(c9);
  expect(transactions.count).toBe(0);
  expect(notes()).toEqual([{ n120: { spell: "C" }, n122: { spell: "D" } }]);
});

test("no note on the line, or the append slot: ], [ and an octave do nothing", () => {
  const { doc, start, beatWith } = keyboard();
  const cursor = beatWith({ n60: { spell: "C" } }, 4);
  const transactions = transactionsOf(doc);
  for (const at of [cursor, start]) {
    expect(moveNotesBySemitone(doc, at, 1)).toEqual(at);
    expect(moveNotesByOctave(doc, at, -1)).toEqual(at);
  }
  expect(transactions.count).toBe(0);
});

test("Delete takes off every note drawn on the cursor's line, in one transaction, and leaves the others", () => {
  const { doc, beatWith, notes } = keyboard();
  const cursor = beatWith({ n60: { spell: "C" }, n61: { spell: "C#" }, n64: { spell: "E" } }, 10);
  const transactions = transactionsOf(doc);
  deleteNote(doc, cursor);
  expect(transactions.count).toBe(1);
  expect(notes()).toEqual([{ n64: { spell: "E" } }]);
});
