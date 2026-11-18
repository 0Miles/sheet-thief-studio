// The clipboard (docs/spec/phrases.md, section 2; docs/spec/commands.md, 5.6): the text a copy
// writes and a paste reads, what a selection copies as, and a paste at the cursor, on real
// documents.
import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  addPart,
  type BeatsFragment,
  CLIPBOARD_PREFIX,
  clipboardText,
  createScore,
  type Cursor,
  cursorAt,
  docToJson,
  type Fragment,
  fragmentOfClipboard,
  fragmentOfSelection,
  insertBars,
  insertBeat,
  partsOf,
  pasteBeats,
  pasteFragment,
  type Pasted,
  setFret,
  voiceIn,
} from "../src/index";
import { appendBeat, transactionsOf, undoOf } from "./support";

const GUITAR = [64, 59, 55, 50, 45, 40];
const BASS = [43, 38, 33, 28];

/** A guitar, a bass and drums over three bars of 4/4; the guitar's first bar holds quarters on string 1 of frets 1, 2, 3, 4. */
function band() {
  const doc = new Y.Doc();
  createScore(doc, "Band");
  const barIds = insertBars(doc, { after: null, count: 3 });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted", tuning: GUITAR });
  const bass = addPart(doc, { name: "Bass", kind: "fretted", tuning: BASS });
  const drums = addPart(doc, { name: "Drums", kind: "percussion" });
  let at = cursorAt(doc, guitar, barIds[0]!, 1);
  for (const fret of [1, 2, 3, 4]) at = setFret(doc, appendBeat(doc, at, { value: 4 }), fret);
  const ids = (partId: string, bar: number) => (docToJson(doc).parts.find((part) => part.id === partId)!.content[barIds[bar]!]!["0:0"] ?? []).map((beat) => beat.id);
  const frets = (partId: string, bar: number) =>
    (docToJson(doc).parts.find((part) => part.id === partId)!.content[barIds[bar]!]!["0:0"] ?? []).map((beat) => Object.values(beat.notes).map((note) => (note as { fret?: number }).fret));
  return { doc, barIds, guitar, bass, drums, ids, frets };
}

/** Quarters on string 1, one per fret, as a fragment of beats of the guitar. */
function guitarBeats(...frets: number[]): BeatsFragment {
  return { kind: "fretted", tuning: [...GUITAR], beats: frets.map((fret) => ({ value: 4, dots: 0, notes: { s1: { fret } } })) };
}

function pasted(result: Pasted | string): Pasted {
  if (typeof result === "string") throw new Error(`refused: ${result}`);
  return result;
}

test("the clipboard's text is the prefix, a line feed and the fragment's JSON, and reads back as the fragment", () => {
  const beats = guitarBeats(5, 7);
  const text = clipboardText(beats);
  expect(text).toBe(`sheet-thief-studio/fragment@1\n${JSON.stringify(beats)}`);
  expect(fragmentOfClipboard(text)).toEqual(beats);
  const bars: Fragment = { kind: "percussion", bars: [{ timeSig: { numerator: 3, denominator: 4 }, voices: { "0:0": [] } }] };
  expect(fragmentOfClipboard(clipboardText(bars))).toEqual(bars);
  // A clipboard of Windows may end the line with CR LF.
  expect(fragmentOfClipboard(`${CLIPBOARD_PREFIX}\r\n${JSON.stringify(beats)}`)).toEqual(beats);
});

test("text without the prefix, of another version, not JSON or not a fragment holds nothing to paste", () => {
  const json = JSON.stringify(guitarBeats(5));
  for (const text of [
    json,
    "",
    "hello",
    `sheet-thief-studio/fragment@2\n${json}`,
    `sheet-thief-studio/fragment@1${json}`,
    ` ${CLIPBOARD_PREFIX}\n${json}`,
    `${CLIPBOARD_PREFIX}\n{not json`,
    `${CLIPBOARD_PREFIX}\n${JSON.stringify({ ...guitarBeats(5), id: "x" })}`,
    `${CLIPBOARD_PREFIX}\n${JSON.stringify({ kind: "fretted", beats: [] })}`,
    `${CLIPBOARD_PREFIX}\n${JSON.stringify({ kind: "fretted", tuning: GUITAR, beats: [{ value: 4, dots: 0, notes: { s7: { fret: 1 } } }] })}`,
  ]) {
    expect(fragmentOfClipboard(text), text).toBeUndefined();
  }
});

test("a range of beats copies as a fragment of those beats, without ids; a range of bars as a fragment of bars", () => {
  const { doc, barIds, guitar, ids } = band();
  const [, second, third] = ids(guitar, 0);
  // Focus before anchor: the beats are taken in their order.
  const beats = fragmentOfSelection(doc, { kind: "beats", partId: guitar, barId: barIds[0]!, voice: "0:0", anchorBeatId: third!, focusBeatId: second! });
  expect(beats).toEqual({ kind: "fretted", tuning: GUITAR, beats: [2, 3].map((fret) => ({ value: 4, dots: 0, notes: { s1: { fret } } })) });

  const bars = fragmentOfSelection(doc, { kind: "bars", partId: guitar, anchorBarId: barIds[0]!, focusBarId: barIds[1]! });
  expect(bars).toMatchObject({ kind: "fretted", tuning: GUITAR, bars: [{ timeSig: { numerator: 4, denominator: 4 } }, { timeSig: { numerator: 4, denominator: 4 } }] });
  expect((bars as { bars: { voices: Record<string, unknown[]> }[] }).bars[0]!.voices["0:0"]).toHaveLength(4);

  // What the selection names is gone.
  expect(fragmentOfSelection(doc, { kind: "beats", partId: guitar, barId: barIds[0]!, voice: "0:0", anchorBeatId: "gone", focusBeatId: second! })).toBeUndefined();
});

test("beats pasted on a beat go in before it, in order, with new ids; the cursor goes on the last of them; one transaction", () => {
  const { doc, barIds, guitar, ids, frets } = band();
  const before = ids(guitar, 0);
  const transactions = transactionsOf(doc);
  const cursor: Cursor = { ...cursorAt(doc, guitar, barIds[0]!, 1), beatId: before[1]!, at: "on" };
  const result = pasted(pasteFragment(doc, cursor, guitarBeats(7, 8)));
  expect(transactions.count).toBe(1);
  expect(frets(guitar, 0)).toEqual([[1], [7], [8], [2], [3], [4]]);
  const after = ids(guitar, 0);
  expect(after.filter((id) => !before.includes(id))).toHaveLength(2);
  expect(result).toEqual({ cursor: { ...cursor, beatId: after[2], at: "on" }, hints: [] });
});

test("beats pasted in the append slot go after its anchor; in an empty voice, first", () => {
  const { doc, barIds, guitar, ids, frets } = band();
  const anchor = ids(guitar, 0)[1]!;
  pasted(pasteFragment(doc, { ...cursorAt(doc, guitar, barIds[0]!, 1), beatId: anchor, at: "after" }, guitarBeats(9)));
  expect(frets(guitar, 0)).toEqual([[1], [2], [9], [3], [4]]);

  const empty = cursorAt(doc, guitar, barIds[1]!, 1);
  expect(empty).toMatchObject({ beatId: null, at: "after" });
  const result = pasted(pasteFragment(doc, empty, guitarBeats(5, 6)));
  expect(frets(guitar, 1)).toEqual([[5], [6]]);
  expect(result.cursor).toEqual({ ...empty, beatId: ids(guitar, 1)[1], at: "on" });
});

test("beats are pasted only into a part of their kind with the strings they use; another tuning is told", () => {
  const { doc, barIds, bass, drums, frets } = band();
  const transactions = transactionsOf(doc);
  expect(pasteBeats(doc, cursorAt(doc, drums, barIds[0]!), guitarBeats(1))).toBe("otherKind");
  const onFifth: BeatsFragment = { kind: "fretted", tuning: [...GUITAR], beats: [{ value: 4, dots: 0, notes: { s5: { fret: 3 } } }] };
  expect(pasteBeats(doc, cursorAt(doc, bass, barIds[0]!, 1), onFifth)).toBe("tooManyStrings");
  expect(transactions.count).toBe(0);
  expect(pasted(pasteFragment(doc, cursorAt(doc, bass, barIds[0]!, 1), guitarBeats(2))).hints).toEqual(["tuningDiffers"]);
  expect(frets(bass, 0)).toEqual([[2]]);
  // The cursor's beat gone; a fragment that does not pass the schema.
  expect(pasteBeats(doc, { ...cursorAt(doc, bass, barIds[0]!, 1), beatId: "gone", at: "on" }, guitarBeats(2))).toBe("gone");
  expect(pasteBeats(doc, cursorAt(doc, bass, barIds[1]!, 1), { ...guitarBeats(2), beats: [] })).toBe("invalid");
});

test("bars pasted replace bars from the cursor's, as a drop; the cursor goes to the start of that bar in its voice, and one undo step undoes it", () => {
  const { doc, barIds, guitar, frets } = band();
  const copied = fragmentOfSelection(doc, { kind: "bars", partId: guitar, anchorBarId: barIds[0]!, focusBarId: barIds[0]! })!;
  // Something to be replaced where it goes.
  setFret(doc, insertBeat(doc, cursorAt(doc, guitar, barIds[2]!, 1)), 12);
  const undo = undoOf(doc);
  const cursor = cursorAt(doc, guitar, barIds[2]!, 1);
  const result = pasted(pasteFragment(doc, cursor, copied));
  expect(frets(guitar, 2)).toEqual([[1], [2], [3], [4]]);
  const first = voiceIn(doc, { partId: guitar, barId: barIds[2]!, voice: "0:0" })!.get(0).get("id");
  expect(result).toEqual({ cursor: { ...cursor, beatId: first, at: "on" }, hints: [] });
  undo.undo();
  expect(frets(guitar, 2)).toEqual([[12]]);
});

test("bars pasted are refused into a part of another kind, and appended past the end of the score", () => {
  const { doc, barIds, guitar, drums, frets } = band();
  const copied = fragmentOfSelection(doc, { kind: "bars", partId: guitar, anchorBarId: barIds[0]!, focusBarId: barIds[1]! })!;
  expect(pasteFragment(doc, cursorAt(doc, drums, barIds[0]!), copied)).toBe("otherKind");
  expect(pasted(pasteFragment(doc, cursorAt(doc, guitar, barIds[2]!, 1), copied)).hints).toEqual(["barsAppended"]);
  expect(docToJson(doc).bars).toHaveLength(4);
  expect(frets(guitar, 2)).toEqual([[1], [2], [3], [4]]);
  expect(partsOf(doc).size).toBe(3);
});
