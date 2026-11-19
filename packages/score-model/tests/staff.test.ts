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
  flagsOf,
  insertBars,
  insertBeat,
  type KeySignature,
  lineOfPitch,
  moveNotesByOctave,
  moveNotesBySemitone,
  type NoteJSON,
  noteKeysAt,
  setClef,
  setKeySig,
  setNote,
  tieKeysAt,
  tieToggle,
  toggleKeysAt,
  voiceIn,
} from "../src/index";
import { appendBeat, transactionsOf, undoOf } from "./support";

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

// Tie on a staff (#49; docs/spec/commands.md, 5.4): the notes of the cursor's line, or, on an
// empty line, the notes the beat before draws on that line, made there of the same pitch.
const tieAt = (doc: Y.Doc, cursor: Cursor) => toggleKeysAt(doc, cursor, tieKeysAt(doc, cursor), tieToggle);

test("on an empty line a tie makes there every note the beat before draws on it, D and D♯ alike, of their pitch and spelling; again, it takes the ties off", () => {
  const { doc, start, notes } = keyboard();
  // D5 and D♯5 on line 2, F5 on line 0.
  const first = enterNote(doc, { ...start, line: 2 }, "D");
  setNote(doc, first, "n75", { spell: "D#", accent: true });
  setNote(doc, first, "n77", { spell: "F" });
  const second = appendBeat(doc, first);
  expect(tieKeysAt(doc, second).sort()).toEqual(["n74", "n75"]);
  const transactions = transactionsOf(doc);
  expect(tieAt(doc, second)).toEqual(second);
  expect(transactions.count).toBe(1);
  expect(notes()[1]).toEqual({ n74: { spell: "D", tie: true }, n75: { spell: "D#", tie: true } });
  expect(flagsOf(docToJson(doc)).filter((flag) => flag.kind === "danglingTie")).toEqual([]);
  // The line holds the notes now: the tie key is on them, and off when they all have it.
  expect(tieKeysAt(doc, second).sort()).toEqual(["n74", "n75"]);
  tieAt(doc, second);
  expect(notes()[1]).toEqual({ n74: { spell: "D" }, n75: { spell: "D#" } });
});

test("on a line with a note a tie ties the notes there, whatever the beat before holds; a line the beat before has nothing on is left alone", () => {
  const { doc, start, notes } = keyboard();
  const first = enterNote(doc, { ...start, line: 2 }, "D");
  const second = enterNote(doc, appendBeat(doc, first), "E");
  // E5 on line 1: the D before is on another line, so the tie dangles.
  tieAt(doc, second);
  expect(notes()[1]).toEqual({ n76: { spell: "E", tie: true } });
  expect(flagsOf(docToJson(doc)).filter((flag) => flag.kind === "danglingTie").map((flag) => "noteKey" in flag && flag.noteKey)).toEqual(["n76"]);
  const transactions = transactionsOf(doc);
  const empty = { ...second, line: 6 };
  expect(tieKeysAt(doc, empty)).toEqual([]);
  expect(tieAt(doc, empty)).toEqual(empty);
  expect(transactions.count).toBe(0);
});

test("in the append slot of the next bar's bass staff, a tie makes a beat with the last note of that staff's voice in the bar before", () => {
  const { doc, notes, barIds, partId } = keyboard();
  // On the bass staff, from D3 (its middle line), F is F3 on line 2.
  const bass = { ...cursorAt(doc, partId, barIds[0]!, 4), voice: "1:0" };
  const entered = enterNote(doc, bass, "F");
  expect(entered.line).toBe(2);
  const next: Cursor = { ...bass, barId: barIds[1]!, beatId: null, at: "after", line: 2 };
  expect(tieKeysAt(doc, next)).toEqual(["n53"]);
  // Nothing of the treble staff is looked at: its voice in the bar before is empty.
  expect(tieKeysAt(doc, { ...next, voice: "0:0" })).toEqual([]);
  const tied = tieAt(doc, next);
  expect(tied).toMatchObject({ at: "on", voice: "1:0", line: 2 });
  expect(notes("1:0", 1)).toEqual([{ n53: { spell: "F", tie: true } }]);
  expect(flagsOf(docToJson(doc)).filter((flag) => flag.kind === "danglingTie")).toEqual([]);
});

const C_MAJOR: KeySignature = { fifths: 0, mode: "major" };
const F_MAJOR: KeySignature = { fifths: -1, mode: "major" };

/** A beat holding `before` in the first bar, in `own` key, and the cursor in the append slot of the second bar, in `next` key, on `line` of the treble staff. */
function acrossBars(own: KeySignature, next: KeySignature, before: Record<string, NoteJSON>, line: number) {
  const made = keyboard(own);
  const first = made.beatWith(before);
  setKeySig(made.doc, { ...first, barId: made.barIds[1]! }, next);
  const cursor: Cursor = { ...first, barId: made.barIds[1]!, beatId: null, at: "after", line };
  return { ...made, cursor };
}

test("the beat before draws its notes in the key of its own bar: an unspelled B♭ in F major is tied on B's line in a bar of C major, spelled B♭ to be drawn there; again, only the tie goes", () => {
  // In C major n70 unspelled would be A♯, on A's line (5), not on the cursor's (4).
  const { doc, cursor, notes } = acrossBars(F_MAJOR, C_MAJOR, { n70: {} }, 4);
  expect(tieKeysAt(doc, cursor)).toEqual(["n70"]);
  expect(tieKeysAt(doc, { ...cursor, line: 5 })).toEqual([]);
  const transactions = transactionsOf(doc);
  const tied = tieAt(doc, cursor);
  expect(transactions.count).toBe(1);
  expect(tied).toMatchObject({ at: "on", line: 4 });
  expect(notes("0:0", 1)).toEqual([{ n70: { spell: "Bb", tie: true } }]);
  expect(lineOfPitch("treble", 70, "Bb", C_MAJOR)).toBe(cursor.line);
  // The note is on the cursor's line now: the tie key is on it there, and not on A's line.
  expect(tieKeysAt(doc, tied)).toEqual(["n70"]);
  expect(tieKeysAt(doc, { ...tied, line: 5 })).toEqual([]);
  tieAt(doc, tied);
  expect(notes("0:0", 1)).toEqual([{ n70: { spell: "Bb" } }]);
});

test("a tie writes a spelling only where the note would be drawn off the cursor's line without it", () => {
  // The same bar: the unspelled B♭ of F major is on B's line in the beat after too.
  const same = keyboard(F_MAJOR);
  const second = appendBeat(same.doc, same.beatWith({ n70: {} }));
  expect(tieAt(same.doc, second)).toEqual(second);
  expect(same.notes()[1]).toEqual({ n70: { tie: true } });
  expect(lineOfPitch("treble", 70, undefined, F_MAJOR)).toBe(4);
  // Another key that spells it the same way: B♭ major.
  const flats: KeySignature = { fifths: -2, mode: "major" };
  const alike = acrossBars(F_MAJOR, flats, { n70: {} }, 4);
  tieAt(alike.doc, alike.cursor);
  expect(alike.notes("0:0", 1)).toEqual([{ n70: { tie: true } }]);
  expect(lineOfPitch("treble", 70, undefined, flats)).toBe(4);
  // A note spelled as its pitch is, is made with that spelling, in whatever key: A♯ on A's line.
  const spelled = acrossBars(F_MAJOR, C_MAJOR, { n70: { spell: "A#" } }, 5);
  expect(tieKeysAt(spelled.doc, { ...spelled.cursor, line: 4 })).toEqual([]);
  tieAt(spelled.doc, spelled.cursor);
  expect(spelled.notes("0:0", 1)).toEqual([{ n70: { spell: "A#", tie: true } }]);
  expect(lineOfPitch("treble", 70, "A#", C_MAJOR)).toBe(5);
  const flat = acrossBars(C_MAJOR, { fifths: 2, mode: "major" }, { n70: { spell: "Bb" } }, 4);
  tieAt(flat.doc, flat.cursor);
  expect(flat.notes("0:0", 1)).toEqual([{ n70: { spell: "Bb", tie: true } }]);
  expect(lineOfPitch("treble", 70, "Bb", { fifths: 2, mode: "major" })).toBe(4);
});

// #182: a pitch is one note of a beat. E♭5 at the cursor is D♯5's pitch, drawn on E's line (1), not on D's (2).
test("a pitch the cursor's beat holds on another line is not the tie's: on the empty line of the D♯ before, with the same pitch here as E♭, nothing", () => {
  const { doc, beatWith, notes } = keyboard();
  const first = beatWith({ n75: { spell: "D#" } }, 2);
  const second = setNote(doc, appendBeat(doc, first), "n75", { spell: "Eb" });
  const onD = { ...second, line: 2 };
  const transactions = transactionsOf(doc);
  expect(tieKeysAt(doc, onD)).toEqual([]);
  expect(tieAt(doc, onD)).toEqual(onD);
  expect(transactions.count).toBe(0);
  expect(notes()).toEqual([{ n75: { spell: "D#" } }, { n75: { spell: "Eb" } }]);
});

test("on the line the E♭ is drawn on, the tie is on it as before: on, not dangling, then off", () => {
  const { doc, beatWith, notes } = keyboard();
  const first = beatWith({ n75: { spell: "D#" } }, 2);
  const onE = { ...setNote(doc, appendBeat(doc, first), "n75", { spell: "Eb" }), line: 1 };
  expect(tieKeysAt(doc, onE)).toEqual(["n75"]);
  tieAt(doc, onE);
  expect(notes()).toEqual([{ n75: { spell: "D#" } }, { n75: { spell: "Eb", tie: true } }]);
  expect(flagsOf(docToJson(doc)).filter((flag) => flag.kind === "danglingTie")).toEqual([]);
  tieAt(doc, onE);
  expect(notes()).toEqual([{ n75: { spell: "D#" } }, { n75: { spell: "Eb" } }]);
});

test("of D and D♯ before, with the D♯'s pitch here as E♭, the tie on D's line makes the D only and leaves the E♭; one transaction", () => {
  const { doc, beatWith, notes } = keyboard();
  const first = beatWith({ n74: { spell: "D" }, n75: { spell: "D#" } }, 2);
  const onD = { ...setNote(doc, appendBeat(doc, first), "n75", { spell: "Eb" }), line: 2 };
  expect(tieKeysAt(doc, onD)).toEqual(["n74"]);
  const transactions = transactionsOf(doc);
  expect(tieAt(doc, onD)).toEqual(onD);
  expect(transactions.count).toBe(1);
  expect(notes()[1]).toEqual({ n74: { spell: "D", tie: true }, n75: { spell: "Eb" } });
  expect(lineOfPitch("treble", 74, "D", C_MAJOR)).toBe(onD.line);
});
