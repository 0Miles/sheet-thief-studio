// Two or three members editing their own copy of the document, then exchanging their changes.
import fc from "fast-check";
import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  addPart,
  barsOf,
  createScore,
  type Cursor,
  cursorAt,
  docToJson,
  fillMissingContent,
  insertBars,
  insertBeat,
  LOCAL,
  moveByBeat,
  type NoteValue,
  partsOf,
  setDuration,
  setFret,
  settleCursor,
} from "../src/index";
import { appendBeat } from "./support";

/** A score and copies of it for each member, all in the same state. */
function members(count: number, bars = 2) {
  const first = new Y.Doc();
  createScore(first, "Demo");
  const barIds = insertBars(first, { after: null, count: bars });
  const partId = addPart(first, { name: "Guitar", kind: "fretted" });
  const docs = [first, ...Array.from({ length: count - 1 }, () => new Y.Doc())];
  sync(docs);
  return { docs, barIds, partId };
}

function send(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

function sync(docs: Y.Doc[]): void {
  for (const from of docs) for (const to of docs) if (from !== to) send(from, to);
}

function beats(doc: Y.Doc, barId: string) {
  return docToJson(doc).parts[0]!.content[barId]!["0:0"]!;
}

test("beats typed by two members in the same bar at the same time are all kept, each run together", () => {
  const { docs, barIds, partId } = members(2);
  const [a, b] = docs as [Y.Doc, Y.Doc];
  const typed = (doc: Y.Doc, frets: number[]) => {
    let cursor = cursorAt(doc, partId, barIds[0]!, 6);
    for (const fret of frets) {
      cursor = appendBeat(doc, cursor, { value: 8 });
      setFret(doc, cursor, fret);
    }
  };
  typed(a, [1, 2, 3]);
  typed(b, [7, 8, 9]);
  sync(docs);

  expect(docToJson(a)).toEqual(docToJson(b));
  const frets = beats(a, barIds[0]!).map((beat) => beat.notes.s6!.fret);
  expect([[1, 2, 3, 7, 8, 9], [7, 8, 9, 1, 2, 3]]).toContainEqual(frets);
  expect(new Set(beats(a, barIds[0]!).map((beat) => beat.id)).size).toBe(6);
});

/**
 * Type frets one after the other on a string, from the append slot of a voice, as the keys do:
 * a digit makes the beat, → goes on to the append slot after it. The first beat is made an
 * eighth, and the next ones take its length. Returns the cursor, in the append slot.
 */
function typeInAppendSlot(doc: Y.Doc, from: Cursor, frets: number[]): Cursor {
  let cursor = from;
  frets.forEach((fret, index) => {
    cursor = setFret(doc, cursor, fret);
    if (index === 0) setDuration(doc, cursor, { value: 8 });
    cursor = moveByBeat(doc, cursor, 1);
    expect(cursor.at).toBe("after");
  });
  return cursor;
}

/** The frets on a string of a bar, with where their beats are in the bar. */
function run(doc: Y.Doc, barId: string, string: string): { frets: number[]; indexes: number[] } {
  const held = beats(doc, barId)
    .map((beat, index) => ({ fret: beat.notes[string]?.fret, index }))
    .filter((item) => item.fret !== undefined);
  return { frets: held.map((item) => item.fret as number), indexes: held.map((item) => item.index) };
}

test("two members typing six beats each in the append slot of the same bar keep each their beats together, in the order typed", () => {
  const { docs, barIds, partId } = members(2);
  const [a, b] = docs as [Y.Doc, Y.Doc];
  const annaFrets = [1, 2, 3, 4, 5, 6];
  const benFrets = [11, 12, 13, 14, 15, 16];
  typeInAppendSlot(a, cursorAt(a, partId, barIds[0]!, 6), annaFrets);
  typeInAppendSlot(b, cursorAt(b, partId, barIds[0]!, 1), benFrets);
  sync(docs);

  expect(docToJson(a)).toEqual(docToJson(b));
  const all = beats(a, barIds[0]!);
  expect(all).toHaveLength(12);
  expect(new Set(all.map((beat) => beat.id)).size).toBe(12);
  const anna = run(a, barIds[0]!, "s6");
  const ben = run(a, barIds[0]!, "s1");
  expect(anna.frets).toEqual(annaFrets);
  expect(ben.frets).toEqual(benFrets);
  // Each run is together: six places in a row.
  for (const { indexes } of [anna, ben]) expect(indexes.at(-1)! - indexes[0]!).toBe(5);
});

test("a member whose anchor another member has appended after types right after the anchor", () => {
  const { docs, barIds, partId } = members(2);
  const [a, b] = docs as [Y.Doc, Y.Doc];
  const annaSlot = typeInAppendSlot(a, cursorAt(a, partId, barIds[0]!, 6), [1, 2]);
  sync(docs);
  // Ben goes to the end of the bar, the same append slot, and types two beats there.
  let benSlot = moveByBeat(b, cursorAt(b, partId, barIds[0]!, 1), 1);
  benSlot = moveByBeat(b, benSlot, 1);
  expect(benSlot).toMatchObject({ beatId: annaSlot.beatId, at: "after" });
  typeInAppendSlot(b, benSlot, [7, 8]);
  sync(docs);

  // Anna's append slot still stands on her anchor; her next beat goes right after it.
  expect(settleCursor(a, annaSlot)).toEqual(annaSlot);
  setFret(a, annaSlot, 3);
  sync(docs);
  expect(beats(b, barIds[0]!).map((beat) => beat.notes.s6?.fret ?? beat.notes.s1?.fret)).toEqual([1, 2, 3, 7, 8]);
  expect(docToJson(a)).toEqual(docToJson(b));
});

test("notes put on different strings of the same beat at the same time are both kept", () => {
  const { docs, barIds, partId } = members(2);
  const [a, b] = docs as [Y.Doc, Y.Doc];
  const cursor = insertBeat(a, cursorAt(a, partId, barIds[0]!, 6), { value: 4 });
  sync(docs);
  setFret(a, cursor, 3);
  setFret(b, { ...cursor, line: 4 }, 5);
  sync(docs);
  expect(beats(a, barIds[0]!)[0]!.notes).toEqual({ s6: { fret: 3 }, s4: { fret: 5 } });
  expect(docToJson(a)).toEqual(docToJson(b));
});

test("two frets put on the same string at the same time end as one of them, the same for everyone", () => {
  const { docs, barIds, partId } = members(2);
  const [a, b] = docs as [Y.Doc, Y.Doc];
  const cursor = insertBeat(a, cursorAt(a, partId, barIds[0]!, 6), { value: 4 });
  sync(docs);
  setFret(a, cursor, 3);
  setFret(b, cursor, 12);
  sync(docs);
  expect(docToJson(a)).toEqual(docToJson(b));
  expect([3, 12]).toContain(beats(a, barIds[0]!)[0]!.notes.s6!.fret);
});

test("undo takes back only what the member did", () => {
  const { docs, barIds, partId } = members(2);
  const [a, b] = docs as [Y.Doc, Y.Doc];
  const undo = new Y.UndoManager([barsOf(a), partsOf(a)], { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
  const cursor = insertBeat(a, cursorAt(a, partId, barIds[0]!, 6), { value: 4 });
  sync(docs);
  setFret(a, cursor, 3);
  setFret(b, { ...cursor, line: 5 }, 5);
  sync(docs);

  undo.undo();
  sync(docs);
  expect(beats(b, barIds[0]!)[0]!.notes).toEqual({ s5: { fret: 5 } });
  undo.redo();
  sync(docs);
  expect(beats(b, barIds[0]!)[0]!.notes).toEqual({ s6: { fret: 3 }, s5: { fret: 5 } });
});

test("a bar and a part made at the same time miss each other until the server fills the gap", () => {
  const { docs, barIds } = members(2);
  const [a, b] = docs as [Y.Doc, Y.Doc];
  const [bar] = insertBars(a, { after: barIds[1]!, count: 1 });
  const bass = addPart(b, { name: "Bass", kind: "fretted", tuning: [43, 38, 33, 28] });
  sync(docs);
  const part = () => docToJson(b).parts.find((item) => item.id === bass)!;
  expect(part().content[bar!]).toBeUndefined();
  expect(insertBeat(b, cursorAt(b, bass, bar!), { value: 4 }).beatId).toBeNull();

  fillMissingContent(a);
  sync(docs);
  expect(part().content[bar!]).toEqual({ "0:0": [] });
  expect(docToJson(a)).toEqual(docToJson(b));
});

type Step =
  | { kind: "beat"; member: number; bar: number; value: NoteValue }
  | { kind: "fret"; member: number; bar: number; line: number; fret: number }
  | { kind: "duration"; member: number; bar: number; value: NoteValue }
  | { kind: "send"; from: number; to: number };

const noteValue = fc.constantFrom<NoteValue>(2, 4, 8, 16);
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("beat" as const), member: fc.nat(2), bar: fc.nat(1), value: noteValue }),
  fc.record({ kind: fc.constant("fret" as const), member: fc.nat(2), bar: fc.nat(1), line: fc.integer({ min: 1, max: 6 }), fret: fc.nat(24) }),
  fc.record({ kind: fc.constant("duration" as const), member: fc.nat(2), bar: fc.nat(1), value: noteValue }),
  fc.record({ kind: fc.constant("send" as const), from: fc.nat(2), to: fc.nat(2) }),
);

test("whatever three members do, in whatever order their changes arrive, they end with the same score", () => {
  fc.assert(
    fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
      const { docs, barIds, partId } = members(3);
      // Each member types at the end of each bar, as someone entering notes does: beats go in
      // the append slot after the member's last one, frets and lengths on that last one.
      const cursors: Cursor[][] = docs.map((doc) => barIds.map((barId) => cursorAt(doc, partId, barId, 6)));
      for (const item of steps) {
        if (item.kind === "send") {
          send(docs[item.from]!, docs[item.to]!);
          continue;
        }
        const doc = docs[item.member]!;
        const cursor = cursors[item.member]![item.bar]!;
        if (item.kind === "beat") cursors[item.member]![item.bar] = appendBeat(doc, cursor, { value: item.value });
        else if (item.kind === "fret") setFret(doc, { ...cursor, at: "on", line: item.line }, item.fret);
        else setDuration(doc, { ...cursor, at: "on" }, { value: item.value });
      }
      sync(docs);
      sync(docs);
      const [first, ...others] = docs.map(docToJson);
      for (const other of others) expect(other).toEqual(first);
      const typed = steps.filter((item) => item.kind === "beat").length;
      const ids = barIds.flatMap((barId) => beats(docs[0]!, barId).map((beat) => beat.id));
      expect(ids).toHaveLength(typed);
      expect(new Set(ids).size).toBe(typed);
    }),
    { numRuns: 200 },
  );
});
