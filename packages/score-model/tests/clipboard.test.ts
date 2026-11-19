// The clipboard (docs/spec/phrases.md, section 2; docs/spec/commands.md, 5.6): the text a copy
// writes and a paste reads, what a selection copies as, and beats pasted at the cursor, on real
// documents. Bars pasted are dropped: drop.test.ts, and the editor's clipboard.test.ts.
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
  MAX_FRAGMENT_BYTES,
  MAX_VALUE_DEPTH,
  pasteBeats,
  setFret,
  STANDARD_GUITAR,
} from "../src/index";
import { accepted, appendBeat, transactionsOf } from "./support";

const BASS = [43, 38, 33, 28];

/** A guitar, a bass and drums over three bars of 4/4; the guitar's first bar holds quarters on string 1 of frets 1, 2, 3, 4. */
function band() {
  const doc = new Y.Doc();
  createScore(doc, "Band");
  const barIds = insertBars(doc, { after: null, count: 3 });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted", tuning: STANDARD_GUITAR });
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
  return { kind: "fretted", tuning: [...STANDARD_GUITAR], beats: frets.map((fret) => ({ value: 4, dots: 0, notes: { s1: { fret } } })) };
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
    `sheet-thief-studio/fragment@10\n${json}`,
    `sheet-thief-studioXfragment@1\n${json}`,
    ` ${CLIPBOARD_PREFIX}\n${json}`,
    `${CLIPBOARD_PREFIX}\n{not json`,
    `${CLIPBOARD_PREFIX}\n${JSON.stringify({ ...guitarBeats(5), id: "x" })}`,
    `${CLIPBOARD_PREFIX}\n${JSON.stringify({ kind: "fretted", beats: [] })}`,
    `${CLIPBOARD_PREFIX}\n${JSON.stringify({ kind: "fretted", tuning: STANDARD_GUITAR, beats: [{ value: 4, dots: 0, notes: { s7: { fret: 1 } } }] })}`,
  ]) {
    expect(fragmentOfClipboard(text), text).toBeUndefined();
  }
});

test("a field named __proto__ makes a record of notes or voices nothing to paste; on an object it is left out, the prototype untouched", () => {
  for (const json of [
    `{"kind":"fretted","tuning":[64,59,55,50,45,40],"beats":[{"value":4,"dots":0,"notes":{"s1":{"fret":1},"__proto__":{"fret":2}}}]}`,
    `{"kind":"percussion","bars":[{"timeSig":{"numerator":4,"denominator":4},"voices":{"0:0":[],"__proto__":[]}}]}`,
  ]) {
    expect(fragmentOfClipboard(`${CLIPBOARD_PREFIX}\n${json}`), json).toBeUndefined();
  }
  const read = fragmentOfClipboard(`${CLIPBOARD_PREFIX}\n${JSON.stringify(guitarBeats(1)).replace(/^\{/, '{"__proto__":{"kind":"pitched","polluted":true},')}`);
  expect(read).toEqual(guitarBeats(1));
  expect(Object.getPrototypeOf(read)).toBe(Object.prototype);
  expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
});

test("a value nested far deeper than MAX_VALUE_DEPTH is read without failing, and never kept", () => {
  // As JSON text: JSON.stringify of such a value would itself overflow the stack.
  const deep = `${'{"inner":'.repeat(MAX_VALUE_DEPTH * 1000)}1${"}".repeat(MAX_VALUE_DEPTH * 1000)}`;
  const beat = (notes: string) => `{"value":4,"dots":0,"notes":${notes}}`;
  // Where the notes are: not notes.
  expect(fragmentOfClipboard(`${CLIPBOARD_PREFIX}\n{"kind":"fretted","tuning":[64,59,55,50,45,40],"beats":[${beat(deep)}]}`)).toBeUndefined();
  // Where the tuplet is: not a tuplet.
  expect(fragmentOfClipboard(`${CLIPBOARD_PREFIX}\n{"kind":"fretted","tuning":[64,59,55,50,45,40],"beats":[{"value":4,"dots":0,"tuplet":${deep},"notes":{}}]}`)).toBeUndefined();
  // In a field the schema does not know, left out, however deep (docs/spec/phrases.md, 1.1).
  const fragment = JSON.stringify(guitarBeats(3)).replace(/^\{/, `{"later":${deep},`);
  expect(fragmentOfClipboard(`${CLIPBOARD_PREFIX}\n${fragment}`)).toEqual(guitarBeats(3));
});

test("more than a fragment's 1 MB is nothing to paste, and JSON longer than that is not even parsed", () => {
  const many = guitarBeats(...Array.from({ length: Math.ceil(MAX_FRAGMENT_BYTES / 40) }, () => 5));
  expect(JSON.stringify(many).length).toBeGreaterThan(MAX_FRAGMENT_BYTES);
  expect(fragmentOfClipboard(clipboardText(many))).toBeUndefined();
  // Small once parsed, but past the limit as text: refused before JSON.parse.
  const padded = `${CLIPBOARD_PREFIX}\n${JSON.stringify(guitarBeats(5))}${" ".repeat(MAX_FRAGMENT_BYTES)}`;
  const parse = JSON.parse;
  let parsed = 0;
  JSON.parse = (...args: Parameters<typeof JSON.parse>) => {
    parsed += 1;
    return parse(...args);
  };
  try {
    expect(fragmentOfClipboard(padded)).toBeUndefined();
  } finally {
    JSON.parse = parse;
  }
  expect(parsed).toBe(0);
  // Right at the limit, it is parsed.
  const fits = JSON.stringify(guitarBeats(5));
  expect(fragmentOfClipboard(`${CLIPBOARD_PREFIX}\n${fits}${" ".repeat(MAX_FRAGMENT_BYTES - fits.length)}`)).toEqual(guitarBeats(5));
});

test("a range of beats copies as a fragment of those beats, without ids; a range of bars as a fragment of bars", () => {
  const { doc, barIds, guitar, drums, ids } = band();
  const [, second, third] = ids(guitar, 0);
  // Focus before anchor: the beats are taken in their order.
  const beats = fragmentOfSelection(doc, { kind: "beats", partId: guitar, barId: barIds[0]!, voice: "0:0", anchorBeatId: third!, focusBeatId: second! });
  expect(beats).toEqual({ kind: "fretted", tuning: STANDARD_GUITAR, beats: [2, 3].map((fret) => ({ value: 4, dots: 0, notes: { s1: { fret } } })) });

  const bars = fragmentOfSelection(doc, { kind: "bars", partId: guitar, anchorBarId: barIds[0]!, focusBarId: barIds[1]! });
  expect(bars).toMatchObject({ kind: "fretted", tuning: STANDARD_GUITAR, bars: [{ timeSig: { numerator: 4, denominator: 4 } }, { timeSig: { numerator: 4, denominator: 4 } }] });
  expect((bars as { bars: { voices: Record<string, unknown[]> }[] }).bars[0]!.voices["0:0"]).toHaveLength(4);

  // Drums: the kind alone, no tuning.
  const hit = cursorAt(doc, drums, barIds[1]!);
  const pastedHit = accepted(pasteBeats(doc, hit, { kind: "percussion", beats: [{ value: 4, dots: 0, notes: { p38: {} } }] }));
  const drumBeat = pastedHit.beatIds[0]!;
  expect(fragmentOfSelection(doc, { kind: "beats", partId: drums, barId: barIds[1]!, voice: "0:0", anchorBeatId: drumBeat, focusBeatId: drumBeat })).toEqual({
    kind: "percussion",
    beats: [{ value: 4, dots: 0, notes: { p38: {} } }],
  });

  // What the selection names is gone.
  expect(fragmentOfSelection(doc, { kind: "beats", partId: guitar, barId: barIds[0]!, voice: "0:0", anchorBeatId: "gone", focusBeatId: second! })).toBeUndefined();
});

test("beats pasted on a beat go in before it, in order, with new ids; one transaction", () => {
  const { doc, barIds, guitar, ids, frets } = band();
  const before = ids(guitar, 0);
  const transactions = transactionsOf(doc);
  const cursor: Cursor = { ...cursorAt(doc, guitar, barIds[0]!, 1), beatId: before[1]!, at: "on" };
  const result = accepted(pasteBeats(doc, cursor, guitarBeats(7, 8)));
  expect(transactions.count).toBe(1);
  expect(frets(guitar, 0)).toEqual([[1], [7], [8], [2], [3], [4]]);
  const after = ids(guitar, 0);
  expect(result).toEqual({ beatIds: after.slice(1, 3), hints: [] });
  expect(after.filter((id) => !before.includes(id))).toEqual(result.beatIds);
});

test("beats pasted in the append slot go after its anchor; in an empty voice, first", () => {
  const { doc, barIds, guitar, ids, frets } = band();
  const anchor = ids(guitar, 0)[1]!;
  accepted(pasteBeats(doc, { ...cursorAt(doc, guitar, barIds[0]!, 1), beatId: anchor, at: "after" }, guitarBeats(9)));
  expect(frets(guitar, 0)).toEqual([[1], [2], [9], [3], [4]]);

  const empty = cursorAt(doc, guitar, barIds[1]!, 1);
  expect(empty).toMatchObject({ beatId: null, at: "after" });
  const result = accepted(pasteBeats(doc, empty, guitarBeats(5, 6)));
  expect(frets(guitar, 1)).toEqual([[5], [6]]);
  expect(result.beatIds).toEqual(ids(guitar, 1));
});

test("beats are pasted only into a part of their kind with the strings they use; another tuning is told", () => {
  const { doc, barIds, bass, drums, frets } = band();
  const transactions = transactionsOf(doc);
  expect(pasteBeats(doc, cursorAt(doc, drums, barIds[0]!), guitarBeats(1))).toBe("otherKind");
  const onFifth: BeatsFragment = { kind: "fretted", tuning: [...STANDARD_GUITAR], beats: [{ value: 4, dots: 0, notes: { s5: { fret: 3 } } }] };
  expect(pasteBeats(doc, cursorAt(doc, bass, barIds[0]!, 1), onFifth)).toBe("tooManyStrings");
  expect(transactions.count).toBe(0);
  expect(accepted(pasteBeats(doc, cursorAt(doc, bass, barIds[0]!, 1), guitarBeats(2))).hints).toEqual(["tuningDiffers"]);
  expect(frets(bass, 0)).toEqual([[2]]);
  // The cursor's beat gone; a fragment that does not pass the schema.
  expect(pasteBeats(doc, { ...cursorAt(doc, bass, barIds[0]!, 1), beatId: "gone", at: "on" }, guitarBeats(2))).toBe("gone");
  expect(pasteBeats(doc, cursorAt(doc, bass, barIds[1]!, 1), { ...guitarBeats(2), beats: [] })).toBe("invalid");
});
