// Structural commands (docs/spec/commands.md, section 6): bars inserted and deleted for every
// part at once, time signatures and tempo changes. Each is one transaction, one undo step.
import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  addPart,
  appendBar,
  barsOf,
  contentOf,
  createScore,
  type Cursor,
  cursorAt,
  DEFAULT_TEMPO,
  deleteBarsAt,
  docToJson,
  insertBarAt,
  insertBars,
  LOCAL,
  MAX_BARS,
  partsOf,
  type Selection,
  setFret,
  setTempo,
  setTimeSig,
  startOfScore,
  structuralRange,
  tempoAt,
  type TimeSignature,
} from "../src/index";
import { appendBeat, transactionsOf, undoOf } from "./support";

const THREE_FOUR: TimeSignature = { numerator: 3, denominator: 4 };
const SIX_EIGHT: TimeSignature = { numerator: 6, denominator: 8 };

/** A guitar and a keyboard on two staves over `count` bars of 4/4. */
function band(count = 3) {
  const doc = new Y.Doc();
  createScore(doc, "Band");
  const barIds = insertBars(doc, { after: null, count });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted" });
  const keys = addPart(doc, { name: "Keys", kind: "pitched", staves: [{ clef: "treble" }, { clef: "bass" }] });
  const at = (bar: number, line = 2): Cursor => cursorAt(doc, guitar, barIds[bar]!, line);
  const bars = () => docToJson(doc).bars;
  const signatures = () => bars().map((bar) => `${bar.timeSig.numerator}/${bar.timeSig.denominator}`);
  return { doc, barIds, guitar, keys, at, bars, signatures };
}

const barRange = (partId: string, anchorBarId: string, focusBarId: string): Selection => ({ kind: "bars", partId, anchorBarId, focusBarId });

/** The cursor a command gave, failing on a refusal. */
function cursorOf(result: Cursor | string): Cursor {
  if (typeof result === "string") throw new Error(`refused: ${result}`);
  return result;
}

test("a bar inserted before the cursor's bar, or after it, gets a place in every part in one transaction, and the cursor moves to its first place", () => {
  const { doc, barIds, guitar, keys, at, bars } = band(2);
  const transactions = transactionsOf(doc);
  const before = cursorOf(insertBarAt(doc, { ...at(1), line: 4 }, "before"));
  expect(transactions.count).toBe(1);
  const after = cursorOf(insertBarAt(doc, at(1), "after"));
  expect(transactions.count).toBe(2);
  expect(bars().map((bar) => bar.id)).toEqual([barIds[0], before.barId, barIds[1], after.barId]);
  // On the cursor's line, in the append slot of its empty voice.
  expect(before).toEqual({ partId: guitar, barId: before.barId, voice: "0:0", beatId: null, at: "after", line: 4 });
  for (const partId of [guitar, keys]) {
    for (const barId of [before.barId, after.barId]) expect(contentOf(partsOf(doc).get(partId)!).has(barId)).toBe(true);
  }
  expect([...contentOf(partsOf(doc).get(keys)!).get(after.barId)!.keys()].sort()).toEqual(["0:0", "0:1", "1:0", "1:1"]);
});

test("a new bar takes the time signature of the bar before it, and the first bar that of the bar after it", () => {
  const { doc, barIds, at, signatures } = band(2);
  barsOf(doc).get(barIds[0]!)!.set("timeSig", THREE_FOUR);
  barsOf(doc).get(barIds[1]!)!.set("timeSig", SIX_EIGHT);
  insertBarAt(doc, at(1), "before");
  expect(signatures()).toEqual(["3/4", "3/4", "6/8"]);
  insertBarAt(doc, at(0), "before");
  expect(signatures()).toEqual(["3/4", "3/4", "3/4", "6/8"]);
  insertBarAt(doc, at(1), "after");
  expect(signatures()).toEqual(["3/4", "3/4", "3/4", "6/8", "6/8"]);
});

test("a new bar takes only the time signature: not the tempo, nor any other change that holds from a bar on", () => {
  const { doc, barIds, at, bars } = band(1);
  const first = barsOf(doc).get(barIds[0]!)!;
  first.set("tempo", 90);
  first.set("keySig", { fifths: 2, mode: "major" });
  first.set("section", "Intro");
  insertBarAt(doc, at(0), "after");
  expect(bars()[1]).toEqual({ id: bars()[1]!.id, timeSig: { numerator: 4, denominator: 4 } });
});

test("a time signature that cannot be read is not copied: the new bar is in 4/4", () => {
  const { doc, barIds, at, signatures } = band(1);
  // Read through parsePlain: an inherited numerator is not one of its own.
  barsOf(doc).get(barIds[0]!)!.set("timeSig", Object.assign(Object.create({ numerator: 3 }) as object, { denominator: 4 }));
  insertBarAt(doc, at(0), "after");
  expect(signatures()).toEqual(["4/4", "4/4"]);
});

test("a bar inserted first takes the pickup away from the bar that was first, in the same transaction", () => {
  const { doc, barIds, at } = band(2);
  barsOf(doc).get(barIds[0]!)!.set("anacrusis", true);
  const transactions = transactionsOf(doc);
  insertBarAt(doc, at(0), "before");
  expect(transactions.count).toBe(1);
  expect(barsOf(doc).get(barIds[0]!)!.has("anacrusis")).toBe(false);
});

test("+bar appends a bar after the last one, the cursor in it", () => {
  const { doc, barIds, at, bars } = band(2);
  const cursor = cursorOf(appendBar(doc, at(0)));
  expect(bars().map((bar) => bar.id)).toEqual([...barIds, cursor.barId]);
  expect(cursor).toMatchObject({ beatId: null, at: "after", voice: "0:0" });
});

test(`no command makes a score of more than ${MAX_BARS} bars`, () => {
  const { doc, at, bars } = band(1);
  expect(insertBars(doc, { after: null, count: MAX_BARS })).toEqual([]);
  expect(insertBars(doc, { after: null, count: MAX_BARS - 1 })).toHaveLength(MAX_BARS - 1);
  const transactions = transactionsOf(doc);
  const cursor = cursorAt(doc, at(0).partId, bars()[0]!.id);
  expect(insertBarAt(doc, cursor, "before")).toBe("tooManyBars");
  expect(insertBarAt(doc, cursor, "after")).toBe("tooManyBars");
  expect(appendBar(doc, cursor)).toBe("tooManyBars");
  expect(transactions.count).toBe(0);
  expect(bars()).toHaveLength(MAX_BARS);
});

test("a bar is not inserted beside a bar that is gone", () => {
  const { doc, barIds, at, bars } = band(2);
  const cursor = at(1);
  barsOf(doc).delete(barIds[1]!);
  expect(insertBars(doc, { after: barIds[1]!, count: 1 })).toEqual([]);
  expect(insertBarAt(doc, cursor, "after")).toEqual(cursor);
  expect(bars()).toHaveLength(1);
});

test("Ctrl+Delete deletes the cursor's bar from every part, and the cursor moves to the first place of the bar after it", () => {
  const { doc, barIds, guitar, keys, at, bars } = band(3);
  const typed = appendBeat(doc, at(2), { value: 4 });
  setFret(doc, typed, 5);
  const transactions = transactionsOf(doc);
  const cursor = deleteBarsAt(doc, at(1), null);
  expect(transactions.count).toBe(1);
  expect(bars().map((bar) => bar.id)).toEqual([barIds[0], barIds[2]]);
  for (const partId of [guitar, keys]) expect(contentOf(partsOf(doc).get(partId)!).has(barIds[1]!)).toBe(false);
  expect(cursor).toEqual({ ...at(2), beatId: typed.beatId, at: "on" });
  // The last bar: the cursor goes to the bar before.
  expect(deleteBarsAt(doc, at(2), null)).toEqual(at(0));
});

test("Ctrl+Delete deletes a bar range, and a beat range's bar", () => {
  const { doc, barIds, keys, at, bars } = band(5);
  expect(deleteBarsAt(doc, at(0), barRange(keys, barIds[3]!, barIds[1]!))).toEqual(at(4));
  expect(bars().map((bar) => bar.id)).toEqual([barIds[0], barIds[4]]);
  const typed = appendBeat(doc, at(4), { value: 4 });
  const beats: Selection = { kind: "beats", partId: typed.partId, barId: barIds[4]!, voice: "0:0", anchorBeatId: typed.beatId!, focusBeatId: typed.beatId! };
  expect(deleteBarsAt(doc, at(0), beats)).toEqual(at(0));
  expect(bars().map((bar) => bar.id)).toEqual([barIds[0]]);
});

test("the last bar is never deleted: deleting every bar is refused, and nothing changes", () => {
  const { doc, barIds, keys, at, bars } = band(2);
  const transactions = transactionsOf(doc);
  expect(deleteBarsAt(doc, at(0), barRange(keys, barIds[0]!, barIds[1]!))).toBe("lastBar");
  deleteBarsAt(doc, at(0), null);
  expect(deleteBarsAt(doc, at(1), null)).toBe("lastBar");
  expect(transactions.count).toBe(1);
  expect(bars().map((bar) => bar.id)).toEqual([barIds[1]]);
});

test("undo brings deleted bars back with what they held then", () => {
  const { doc, at } = band(3);
  const undo = undoOf(doc);
  const typed = appendBeat(doc, at(1), { value: 2 });
  setFret(doc, typed, 7);
  const before = docToJson(doc);
  undo.stopCapturing();
  deleteBarsAt(doc, at(1), null);
  undo.undo();
  expect(docToJson(doc)).toEqual(before);
});

test("deleting bars while another member types in them: what they typed meanwhile is gone, and undo brings back only what the bars held when deleted", () => {
  const { doc: a, barIds, guitar, at } = band(3);
  const b = new Y.Doc();
  const send = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
  const sync = () => {
    send(a, b);
    send(b, a);
  };
  sync();
  const fretsIn = (doc: Y.Doc, barId: string) => docToJson(doc).parts[0]!.content[barId]?.["0:0"]?.map((beat) => beat.notes.s2?.fret);
  const undo = new Y.UndoManager([barsOf(a), partsOf(a)], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
  // Anna's beat is in the bar when she deletes it.
  setFret(a, appendBeat(a, at(1), { value: 4 }), 1);
  sync();
  // Ben types in the same bar before Anna's deletion reaches him.
  setFret(b, appendBeat(b, cursorAt(b, guitar, barIds[1]!, 2), { value: 4 }), 2);
  deleteBarsAt(a, at(1), null);
  sync();
  // The explicit exception to "nothing disappears silently" (docs/adr/0002, addendum).
  expect(docToJson(a)).toEqual(docToJson(b));
  expect(docToJson(b).bars.map((bar) => bar.id)).toEqual([barIds[0], barIds[2]]);
  expect(fretsIn(b, barIds[1]!)).toBeUndefined();

  undo.undo();
  sync();
  expect(docToJson(a)).toEqual(docToJson(b));
  expect(docToJson(b).bars.map((bar) => bar.id)).toEqual(barIds);
  // What the bar held when Anna deleted it comes back; Ben's beat, which arrived after, does not.
  expect(fretsIn(b, barIds[1]!)).toEqual([1]);
});

test("a time signature set without a bar range changes the cursor's bar and the bars after it that had the same one, up to the next change", () => {
  const { doc, barIds, at, signatures } = band(5);
  barsOf(doc).get(barIds[3]!)!.set("timeSig", SIX_EIGHT);
  const transactions = transactionsOf(doc);
  expect(setTimeSig(doc, at(1), null, THREE_FOUR)).toBe(true);
  expect(transactions.count).toBe(1);
  expect(signatures()).toEqual(["4/4", "3/4", "3/4", "6/8", "4/4"]);
  // The bar before a change: that bar only.
  setTimeSig(doc, at(2), null, { numerator: 2, denominator: 2 });
  expect(signatures()).toEqual(["4/4", "3/4", "2/2", "6/8", "4/4"]);
  // From the first bar: up to the bar whose time signature differs, not past it to one that is the same again.
  setTimeSig(doc, at(0), null, SIX_EIGHT);
  expect(signatures()).toEqual(["6/8", "3/4", "2/2", "6/8", "4/4"]);
});

test("a time signature set with a bar range, or a beat range, changes those bars only", () => {
  const { doc, barIds, keys, at, signatures } = band(5);
  setTimeSig(doc, at(0), barRange(keys, barIds[3]!, barIds[1]!), THREE_FOUR);
  expect(signatures()).toEqual(["4/4", "3/4", "3/4", "3/4", "4/4"]);
  const typed = appendBeat(doc, at(4), { value: 4 });
  const beats: Selection = { kind: "beats", partId: typed.partId, barId: barIds[4]!, voice: "0:0", anchorBeatId: typed.beatId!, focusBeatId: typed.beatId! };
  setTimeSig(doc, at(0), beats, SIX_EIGHT);
  expect(signatures()).toEqual(["4/4", "3/4", "3/4", "3/4", "6/8"]);
});

test("a time signature out of range is refused; one already there writes nothing", () => {
  const { doc, at, signatures } = band(2);
  const transactions = transactionsOf(doc);
  for (const wrong of [
    { numerator: 0, denominator: 4 },
    { numerator: 33, denominator: 4 },
    { numerator: 3, denominator: 3 },
    { numerator: 2.5, denominator: 4 },
  ]) {
    expect(setTimeSig(doc, at(0), null, wrong as TimeSignature)).toBe(false);
  }
  expect(setTimeSig(doc, at(0), null, { numerator: 4, denominator: 4 })).toBe(true);
  expect(transactions.count).toBe(0);
  expect(signatures()).toEqual(["4/4", "4/4"]);
});

test("a tempo is written on the cursor's bar only, and clearing it takes that change away", () => {
  const { doc, at, bars } = band(3);
  const transactions = transactionsOf(doc);
  expect(setTempo(doc, at(1), 90)).toBe(true);
  expect(bars().map((bar) => bar.tempo)).toEqual([undefined, 90, undefined]);
  expect(setTempo(doc, at(1), 90)).toBe(true);
  expect(transactions.count).toBe(1);
  expect(setTempo(doc, at(1), null)).toBe(true);
  expect(bars().map((bar) => bar.tempo)).toEqual([undefined, undefined, undefined]);
  expect(setTempo(doc, at(1), null)).toBe(true);
  expect(transactions.count).toBe(2);
});

test("a tempo out of 20 to 400 is refused", () => {
  const { doc, at, bars } = band(1);
  for (const wrong of [19, 401, Number.NaN, Number.POSITIVE_INFINITY]) expect(setTempo(doc, at(0), wrong)).toBe(false);
  expect(setTempo(doc, at(0), 20)).toBe(true);
  expect(setTempo(doc, at(0), 400)).toBe(true);
  expect(bars()[0]!.tempo).toBe(400);
});

test("structural commands on a bar that is gone change nothing", () => {
  const { doc, barIds, at } = band(2);
  const cursor = at(1);
  barsOf(doc).delete(barIds[1]!);
  const transactions = transactionsOf(doc);
  expect(setTimeSig(doc, cursor, null, THREE_FOUR)).toBe(false);
  expect(setTempo(doc, cursor, 90)).toBe(false);
  expect(deleteBarsAt(doc, cursor, null)).toEqual(cursor);
  expect(transactions.count).toBe(0);
});

test("a structural command reads a bar range as its bars, a beat range as its bar, and no selection as none", () => {
  const { doc, barIds, keys } = band(4);
  expect(structuralRange(doc, barRange(keys, barIds[2]!, barIds[0]!))).toEqual(barIds.slice(0, 3));
  const beats: Selection = { kind: "beats", partId: keys, barId: barIds[3]!, voice: "0:0", anchorBeatId: "x", focusBeatId: "x" };
  expect(structuralRange(doc, beats)).toEqual([barIds[3]]);
  expect(structuralRange(doc, null)).toBeNull();
});

test("the start of the score is the first place of the first bar of the first part that can be drawn", () => {
  const { doc, barIds, guitar, keys } = band(2);
  expect(startOfScore(doc)).toEqual(cursorAt(doc, guitar, barIds[0]!));
  expect(startOfScore(doc, new Map([[guitar, 5]]))).toEqual(cursorAt(doc, guitar, barIds[0]!, 5));
  partsOf(doc).get(guitar)!.set("kind", "lute");
  expect(startOfScore(doc)).toEqual(cursorAt(doc, keys, barIds[0]!));
  expect(startOfScore(new Y.Doc())).toBeNull();
});

test("the tempo in force in a bar is that of the last bar up to it that changes it, else 120", () => {
  const { doc, barIds, at } = band(4);
  setTempo(doc, at(1), 90);
  setTempo(doc, at(3), 140);
  const score = docToJson(doc);
  expect(barIds.map((barId) => tempoAt(score, barId))).toEqual([DEFAULT_TEMPO, 90, 90, 140]);
  expect(tempoAt(score, "gone")).toBeUndefined();
});
