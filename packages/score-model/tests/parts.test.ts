// Parts and the score's own fields (docs/spec/commands.md, section 7): parts added from the
// presets, deleted, moved and changed, the title and the artist. Each is one transaction, one undo
// step; two members doing them at once end with the same score.
import { expect, test } from "vitest";
import * as Y from "yjs";

import * as model from "../src/index";
import {
  addPart,
  addPresetPart,
  barsOf,
  barsWithContent,
  canAddPart,
  contentOf,
  createScore,
  cursorAt,
  deletePart,
  docToJson,
  flagsOf,
  insertBars,
  LOCAL,
  MAX_NON_PERCUSSION_PARTS,
  MAX_PARTS,
  metaOf,
  movePart,
  ordered,
  partsOf,
  readScore,
  setArtist,
  setCapo,
  setClef,
  setFret,
  setPartName,
  setProgram,
  setTitle,
  setTuning,
  startOfScore,
  tuningFor,
  tuningOptionOf,
} from "../src/index";
import { appendBeat, transactionsOf } from "./support";

/** A guitar over `count` bars of 4/4. */
function score(count = 3) {
  const doc = new Y.Doc();
  createScore(doc, "Band");
  const barIds = insertBars(doc, { after: null, count });
  const guitar = addPart(doc, { name: "吉他 1", kind: "fretted" });
  const parts = () => docToJson(doc).parts;
  const ids = () => parts().map((part) => part.id);
  return { doc, barIds, guitar, parts, ids };
}

/** An undo manager of this member's commands, the meta among them, each its own step. */
const undoOf = (doc: Y.Doc) => new Y.UndoManager([barsOf(doc), partsOf(doc), metaOf(doc)], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });

/** The id a command that adds a part gave, failing on a refusal. */
function added(result: string | null): string {
  if (result === null || result === "tooManyParts" || result === "lastPart") throw new Error(`refused: ${result}`);
  return result;
}

/** Another member's copy of the score, and a way to hand each one's changes to the other. */
function twoCopies(count = 3) {
  const first = score(count);
  const other = new Y.Doc();
  const sync = () => {
    Y.applyUpdate(other, Y.encodeStateAsUpdate(first.doc, Y.encodeStateVector(other)));
    Y.applyUpdate(first.doc, Y.encodeStateAsUpdate(other, Y.encodeStateVector(first.doc)));
  };
  sync();
  return { ...first, other, sync };
}

test("a part added from a preset gets a place for every bar, every voice of its staves, in one transaction, and the next number of its name", () => {
  const { doc, barIds, parts } = score();
  const transactions = transactionsOf(doc);
  const keys = added(addPresetPart(doc, "keys"));
  expect(transactions.count).toBe(1);
  const bass = added(addPresetPart(doc, "bass5", tuningFor("drop", 5)));
  const guitar = added(addPresetPart(doc, "guitar7"));
  for (const barId of barIds) {
    expect([...contentOf(partsOf(doc).get(keys)!).get(barId)!.keys()].sort()).toEqual(["0:0", "0:1", "1:0", "1:1"]);
    expect([...contentOf(partsOf(doc).get(bass)!).get(barId)!.keys()].sort()).toEqual(["0:0", "0:1"]);
  }
  expect(parts().map(({ name, kind, tuning, capo, program, staves }) => ({ name, kind, tuning, capo, program, staves }))).toEqual([
    { name: "吉他 1", kind: "fretted", tuning: [64, 59, 55, 50, 45, 40], capo: 0, program: 25, staves: [{ clef: "tab" }] },
    { name: "鍵盤 1", kind: "pitched", tuning: [], capo: 0, program: 0, staves: [{ clef: "treble" }, { clef: "bass" }] },
    { name: "貝斯 1", kind: "fretted", tuning: [43, 38, 33, 28, 21], capo: 0, program: 33, staves: [{ clef: "tab" }] },
    { name: "吉他 2", kind: "fretted", tuning: [64, 59, 55, 50, 45, 40, 35], capo: 0, program: 25, staves: [{ clef: "tab" }] },
  ]);
  expect(parts().at(-1)!.id).toBe(guitar);
  // A tuning that does not fit the preset adds nothing.
  expect(addPresetPart(doc, "bass4", [64, 59, 55, 50, 45, 40])).toBeNull();
  expect(addPresetPart(doc, "drums", [40, 45, 50, 55])).toBeNull();
  expect(parts()).toHaveLength(4);
});

test("the 17th part, and the 16th that is not drums, are refused: nothing is added", () => {
  const { doc, parts } = score();
  for (let count = 1; count < MAX_NON_PERCUSSION_PARTS; count++) added(addPresetPart(doc, "vocals"));
  expect(parts()).toHaveLength(MAX_NON_PERCUSSION_PARTS);
  expect(canAddPart(doc, "fretted")).toBe(false);
  expect(canAddPart(doc, "pitched")).toBe(false);
  expect(addPresetPart(doc, "guitar6")).toBe("tooManyParts");
  expect(addPresetPart(doc, "keys")).toBe("tooManyParts");
  expect(parts()).toHaveLength(MAX_NON_PERCUSSION_PARTS);
  // Drums still fit, up to 16 parts in all.
  expect(canAddPart(doc, "percussion")).toBe(true);
  added(addPresetPart(doc, "drums"));
  expect(parts()).toHaveLength(MAX_PARTS);
  expect(canAddPart(doc, "percussion")).toBe(false);
  expect(addPresetPart(doc, "drums")).toBe("tooManyParts");
  expect(parts()).toHaveLength(MAX_PARTS);
});

test("16 parts with drums among them refuse a 17th of any kind", () => {
  const { doc, parts } = score();
  for (let count = 1; count < 10; count++) added(addPresetPart(doc, "guitar6"));
  for (let count = 0; count < 6; count++) added(addPresetPart(doc, "drums"));
  expect(parts()).toHaveLength(MAX_PARTS);
  for (const preset of ["drums", "bass4", "vocals"] as const) expect(addPresetPart(doc, preset)).toBe("tooManyParts");
});

test("a part deleted goes with all it holds, one undo step that brings it back with its content; the last part is kept", () => {
  const { doc, barIds, guitar, parts, ids } = score();
  const bass = added(addPresetPart(doc, "bass4"));
  setFret(doc, appendBeat(doc, cursorAt(doc, bass, barIds[1]!, 2), { value: 4 }), 7);
  const before = docToJson(doc);
  expect(barsWithContent(before, bass)).toBe(1);
  expect(barsWithContent(before, guitar)).toBe(0);
  const undo = undoOf(doc);
  const transactions = transactionsOf(doc);
  expect(deletePart(doc, bass)).toBe(true);
  expect(transactions.count).toBe(1);
  expect(ids()).toEqual([guitar]);
  expect(deletePart(doc, bass)).toBe(false);
  expect(deletePart(doc, guitar)).toBe("lastPart");
  expect(ids()).toEqual([guitar]);
  undo.undo();
  expect(docToJson(doc)).toEqual(before);
  expect(parts()[1]!.content[barIds[1]!]!["0:0"]!.map((beat) => beat.notes)).toEqual([{ s2: { fret: 7 } }]);
});

test("movePart puts a part right after another, or first, changing its own ordering key only", () => {
  const { doc, guitar, ids } = score();
  const bass = added(addPresetPart(doc, "bass4"));
  const drums = added(addPresetPart(doc, "drums"));
  const keys = added(addPresetPart(doc, "keys"));
  const keyOf = (id: string) => partsOf(doc).get(id)!.get("order");
  const others = () => [guitar, bass, keys].map(keyOf);
  const kept = others();
  expect(movePart(doc, drums, null)).toBe(true);
  expect(ids()).toEqual([drums, guitar, bass, keys]);
  expect(others()).toEqual(kept);
  expect(movePart(doc, drums, keys)).toBe(true);
  expect(ids()).toEqual([guitar, bass, keys, drums]);
  expect(movePart(doc, guitar, bass)).toBe(true);
  expect(ids()).toEqual([bass, guitar, keys, drums]);
  // Already there: nothing written.
  const transactions = transactionsOf(doc);
  expect(movePart(doc, guitar, bass)).toBe(true);
  expect(movePart(doc, bass, null)).toBe(true);
  expect(transactions.count).toBe(0);
  // Gone, or after itself: refused.
  expect(movePart(doc, guitar, guitar)).toBe(false);
  expect(movePart(doc, "gone", null)).toBe(false);
  expect(movePart(doc, guitar, "gone")).toBe(false);
  expect(ids()).toEqual([bass, guitar, keys, drums]);
  // Each a step of its own.
  const undo = undoOf(doc);
  movePart(doc, drums, null);
  movePart(doc, keys, null);
  expect(ids()).toEqual([keys, drums, bass, guitar]);
  undo.undo();
  expect(ids()).toEqual([drums, bass, guitar, keys]);
});

test("a new tuning keeps every fret, so the notes sound at new pitches; the number of strings cannot change", () => {
  const { doc, barIds, guitar, parts } = score();
  setFret(doc, appendBeat(doc, cursorAt(doc, guitar, barIds[0]!, 6), { value: 4 }), 3);
  const content = parts()[0]!.content;
  const dropD = tuningFor("drop", 6);
  expect(setTuning(doc, guitar, dropD)).toBe(true);
  expect(parts()[0]!.tuning).toEqual(dropD);
  expect(parts()[0]!.content).toEqual(content);
  expect(tuningOptionOf(parts()[0]!.tuning)).toBe("drop");
  // Five or seven strings, a pitch out of range: nothing set.
  for (const tuning of [tuningFor("standard", 5), tuningFor("standard", 7), [64, 59, 55, 50, 45, 128], [64, 59, 55, 50, 45, 40.5]]) expect(setTuning(doc, guitar, tuning)).toBe(false);
  expect(parts()[0]!.tuning).toEqual(dropD);
  const drums = added(addPresetPart(doc, "drums"));
  const keys = added(addPresetPart(doc, "keys"));
  expect(setTuning(doc, drums, [])).toBe(false);
  expect(setTuning(doc, keys, dropD)).toBe(false);
  expect(tuningOptionOf([64, 59, 55, 50, 45, 41])).toBe("custom");
  expect(tuningOptionOf(tuningFor("halfDown", 4))).toBe("halfDown");
});

test("the capo and the program of a part, its name, and the clef of a staff of a pitched part", () => {
  const { doc, guitar, parts } = score();
  const drums = added(addPresetPart(doc, "drums"));
  const keys = added(addPresetPart(doc, "keys"));
  const part = (id: string) => parts().find((each) => each.id === id)!;
  expect(setCapo(doc, guitar, 3)).toBe(true);
  for (const capo of [-1, 25, 2.5]) expect(setCapo(doc, guitar, capo)).toBe(false);
  expect(setCapo(doc, keys, 2)).toBe(false);
  expect(setCapo(doc, drums, 2)).toBe(false);
  expect(part(guitar).capo).toBe(3);

  expect(setProgram(doc, guitar, 30)).toBe(true);
  expect(setProgram(doc, keys, 4)).toBe(true);
  for (const program of [-1, 128, 1.5]) expect(setProgram(doc, guitar, program)).toBe(false);
  // Drums play on the percussion channel.
  expect(setProgram(doc, drums, 1)).toBe(false);
  expect([part(guitar).program, part(keys).program, part(drums).program]).toEqual([30, 4, 0]);

  expect(setPartName(doc, guitar, "主奏吉他")).toBe(true);
  expect(setPartName(doc, guitar, "")).toBe(false);
  expect(setPartName(doc, guitar, "x".repeat(65))).toBe(false);
  expect(setPartName(doc, "gone", "x")).toBe(false);
  expect(part(guitar).name).toBe("主奏吉他");

  expect(setClef(doc, keys, 1, "treble-8vb")).toBe(true);
  expect(part(keys).staves).toEqual([{ clef: "treble" }, { clef: "treble-8vb" }]);
  // No third staff; no clef a pitched staff cannot have; nothing for tablature or the drum staff.
  expect(setClef(doc, keys, 2, "bass")).toBe(false);
  expect(setClef(doc, keys, 0, "tab" as never)).toBe(false);
  expect(setClef(doc, guitar, 0, "treble")).toBe(false);
  expect(setClef(doc, drums, 0, "bass")).toBe(false);
  expect(part(keys).staves).toEqual([{ clef: "treble" }, { clef: "treble-8vb" }]);
  expect(part(guitar).staves).toEqual([{ clef: "tab" }]);
});

test("each change of a part is one transaction, none when nothing changes", () => {
  const { doc, guitar } = score();
  const transactions = transactionsOf(doc);
  setCapo(doc, guitar, 2);
  setTuning(doc, guitar, tuningFor("halfDown", 6));
  setProgram(doc, guitar, 27);
  setPartName(doc, guitar, "節奏吉他");
  expect(transactions.count).toBe(4);
  setCapo(doc, guitar, 2);
  setTuning(doc, guitar, tuningFor("halfDown", 6));
  setProgram(doc, guitar, 27);
  setPartName(doc, guitar, "節奏吉他");
  expect(transactions.count).toBe(4);
});

test("the title is 1 to 100 characters, the artist up to 100, an empty artist taking it away", () => {
  const { doc } = score();
  const undo = undoOf(doc);
  expect(setTitle(doc, "新標題")).toBe(true);
  expect(setTitle(doc, "")).toBe(false);
  expect(setTitle(doc, "x".repeat(101))).toBe(false);
  expect(setArtist(doc, "樂團")).toBe(true);
  expect(setArtist(doc, "x".repeat(101))).toBe(false);
  expect(docToJson(doc)).toMatchObject({ title: "新標題", artist: "樂團" });
  expect(setArtist(doc, "")).toBe(true);
  expect(docToJson(doc).artist).toBeUndefined();
  expect(metaOf(doc).has("artist")).toBe(false);
  undo.undo();
  expect(docToJson(doc).artist).toBe("樂團");
  undo.undo();
  expect(docToJson(doc).artist).toBeUndefined();
  undo.undo();
  expect(docToJson(doc).title).toBe("Band");
});

test("no command changes the kind of a part, its number of strings or staves, or the clef of a fretted part", () => {
  const exported = Object.keys(model);
  for (const name of ["setKind", "setPartKind", "setStrings", "setStringCount", "setStaves", "setStaffCount", "addStaff", "removeStaff"]) expect(exported).not.toContain(name);
  // What changes a part, all told: `setTuning` keeps the strings, `setClef` refuses all but pitched parts.
  expect(exported.filter((name) => /^(set|add|delete|move)(Part|Tuning|Capo|Program|Clef|Kind|Stave|String)/.test(name)).sort()).toEqual(
    ["addPart", "addPartWithin", "deletePart", "movePart", "setCapo", "setClef", "setPartName", "setProgram", "setTuning"].sort(),
  );
});

// Two members at once -------------------------------------------------------------------------

test("two members deleting the same part at once: it is gone for both, and either one's undo brings it back for both", () => {
  const { doc: a, other: b, sync, guitar, barIds } = twoCopies();
  const bass = added(addPresetPart(a, "bass4"));
  setFret(a, appendBeat(a, cursorAt(a, bass, barIds[0]!, 2), { value: 4 }), 5);
  sync();
  const before = docToJson(a);
  const undoA = undoOf(a);
  expect(deletePart(a, bass)).toBe(true);
  expect(deletePart(b, bass)).toBe(true);
  sync();
  expect(docToJson(a).parts.map((part) => part.id)).toEqual([guitar]);
  expect(docToJson(b)).toEqual(docToJson(a));
  expect(readScore(a).invalid).toEqual([]);
  undoA.undo();
  sync();
  expect(docToJson(a)).toEqual(before);
  expect(docToJson(b)).toEqual(before);
});

test("a part deleted while another member types in it and changes it: it is gone with what they did; undo brings it back as it was when deleted", () => {
  const { doc: a, other: b, sync, guitar, barIds } = twoCopies();
  const bass = added(addPresetPart(a, "bass4"));
  sync();
  const before = docToJson(a);
  const undoA = undoOf(a);
  expect(deletePart(a, bass)).toBe(true);
  setFret(b, appendBeat(b, cursorAt(b, bass, barIds[0]!, 1), { value: 4 }), 9);
  setCapo(b, bass, 2);
  sync();
  expect(docToJson(a).parts.map((part) => part.id)).toEqual([guitar]);
  expect(docToJson(b)).toEqual(docToJson(a));
  // The cursor of the member in it goes to the start of the score.
  expect(startOfScore(b)).toEqual(cursorAt(b, guitar, barIds[0]!));
  undoA.undo();
  sync();
  expect(docToJson(a)).toEqual(before);
  expect(docToJson(b)).toEqual(before);
});

test("two members changing the same field of a part, or the title, at once end with one of the two values, the same for both", () => {
  const { doc: a, other: b, sync, guitar } = twoCopies();
  setCapo(a, guitar, 2);
  setCapo(b, guitar, 5);
  setTuning(a, guitar, tuningFor("drop", 6));
  setTuning(b, guitar, tuningFor("wholeDown", 6));
  setPartName(a, guitar, "甲");
  setPartName(b, guitar, "乙");
  setTitle(a, "標題甲");
  setTitle(b, "標題乙");
  sync();
  const [part] = docToJson(a).parts;
  expect([2, 5]).toContain(part!.capo);
  expect([tuningFor("drop", 6), tuningFor("wholeDown", 6)]).toContainEqual(part!.tuning);
  expect(["甲", "乙"]).toContain(part!.name);
  expect(["標題甲", "標題乙"]).toContain(docToJson(a).title);
  expect(docToJson(b)).toEqual(docToJson(a));
  expect(readScore(a).invalid).toEqual([]);
});

test("two members moving parts at once keep each other's keys apart and end in the same order", () => {
  const { doc: a, other: b, sync, guitar } = twoCopies();
  const bass = added(addPresetPart(a, "bass4"));
  const drums = added(addPresetPart(a, "drums"));
  sync();
  // Both put a part first: each lands there, in an order both agree on.
  movePart(a, drums, null);
  movePart(b, bass, null);
  sync();
  const order = docToJson(a).parts.map((part) => part.id);
  expect(order.slice(0, 2).sort()).toEqual([bass, drums].sort());
  expect(order[2]).toBe(guitar);
  expect(docToJson(b).parts.map((part) => part.id)).toEqual(order);
  const keys = ordered(partsOf(a)).map((id) => partsOf(a).get(id)!.get("order"));
  expect(new Set(keys).size).toBe(3);
  // Both move the same part: it lands where one of them put it.
  movePart(a, guitar, null);
  movePart(b, guitar, order[0]!);
  sync();
  expect(docToJson(b).parts.map((part) => part.id)).toEqual(docToJson(a).parts.map((part) => part.id));
  expect(docToJson(a).parts.map((part) => part.id).indexOf(guitar)).toBeLessThan(2);
});

test("two members each deleting one of the last two parts leave a score of no parts: it still reads, nowhere to put a cursor, and a part added makes one again", () => {
  const { doc: a, other: b, sync, guitar, barIds } = twoCopies(2);
  const bass = added(addPresetPart(a, "bass4"));
  sync();
  expect(deletePart(a, bass)).toBe(true);
  expect(deletePart(b, guitar)).toBe(true);
  sync();
  const { score: read, invalid } = readScore(a);
  expect(read.parts).toEqual([]);
  expect(read.bars.map((bar) => bar.id)).toEqual(barIds);
  expect(flagsOf(read, invalid)).toEqual([]);
  expect(docToJson(b)).toEqual(docToJson(a));
  expect(startOfScore(a)).toBeNull();
  // Nothing fills it in; a member adds a part again.
  const drums = added(addPresetPart(b, "drums"));
  sync();
  expect(startOfScore(a)).toEqual(cursorAt(a, drums, barIds[0]!));
  expect(Object.keys(docToJson(a).parts[0]!.content).sort()).toEqual([...barIds].sort());
});
