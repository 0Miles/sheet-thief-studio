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
  type NoteValue,
  partsOf,
  setDuration,
  setFret,
} from "../src/index";

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
      cursor = insertBeat(doc, cursor, { value: 8 });
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
      // Each member types at the end of each bar, as someone entering notes does.
      const cursors: Cursor[][] = docs.map((doc) => barIds.map((barId) => cursorAt(doc, partId, barId, 6)));
      for (const item of steps) {
        if (item.kind === "send") {
          send(docs[item.from]!, docs[item.to]!);
          continue;
        }
        const doc = docs[item.member]!;
        const cursor = cursors[item.member]![item.bar]!;
        if (item.kind === "beat") cursors[item.member]![item.bar] = insertBeat(doc, cursor, { value: item.value });
        else if (item.kind === "fret") setFret(doc, { ...cursor, line: item.line }, item.fret);
        else setDuration(doc, cursor, { value: item.value });
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
