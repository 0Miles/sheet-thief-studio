// Dropping a phrase (docs/spec/commands.md, 5.7): a fragment of bars put in place of bars of a
// part, on real documents, one transaction and one undo step.
import { expect, test } from "vitest";
import * as Y from "yjs";

import {
  addPart,
  type BarsFragment,
  barsOf,
  createScore,
  cursorAt,
  docToJson,
  dropFragment,
  type Dropped,
  flagsOf,
  insertBars,
  insertBeat,
  MAX_BARS,
  partsOf,
  setFret,
  type TimeSignature,
  voiceIn,
} from "../src/index";
import { appendBeat, transactionsOf, undoOf } from "./support";

const COMMON: TimeSignature = { numerator: 4, denominator: 4 };
const THREE_FOUR: TimeSignature = { numerator: 3, denominator: 4 };
const GUITAR = [64, 59, 55, 50, 45, 40];
const BASS = [43, 38, 33, 28];

/** A guitar, a bass, drums and a keyboard on two staves, over `count` bars of 4/4. */
function band(count = 4) {
  const doc = new Y.Doc();
  createScore(doc, "Band");
  const barIds = insertBars(doc, { after: null, count });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted", tuning: GUITAR });
  const bass = addPart(doc, { name: "Bass", kind: "fretted", tuning: BASS });
  const drums = addPart(doc, { name: "Drums", kind: "percussion" });
  const keys = addPart(doc, { name: "Keys", kind: "pitched", staves: [{ clef: "treble" }, { clef: "bass" }] });
  const content = (partId: string) => docToJson(doc).parts.find((part) => part.id === partId)!.content;
  return { doc, barIds, guitar, bass, drums, keys, content };
}

/** A quarter on each fret given, on a string. */
function quarters(string: number, frets: number[]) {
  return frets.map((fret) => ({ value: 4 as const, dots: 0 as const, notes: { [`s${string}`]: { fret } } }));
}

/** A fragment of a guitar part: each bar four quarters, on string 6, of the frets given. */
function guitarPhrase(...bars: number[][]): BarsFragment {
  return { kind: "fretted", tuning: [...GUITAR], bars: bars.map((frets) => ({ timeSig: { ...COMMON }, voices: { "0:0": quarters(6, frets) } })) };
}

/** The frets of a voice, beat by beat, on any string. */
function frets(beats: { notes: Record<string, { fret?: number }> }[] | undefined) {
  return (beats ?? []).map((beat) => Object.values(beat.notes).map((note) => note.fret));
}

/** What a drop gave, failing on a refusal. */
function dropped(result: Dropped | string): Dropped {
  if (typeof result === "string") throw new Error(`refused: ${result}`);
  return result;
}

test("a phrase of N bars takes the place of N bars of the part from the bar dropped on, every voice of them, and no other part", () => {
  const { doc, barIds, guitar, bass, content } = band(4);
  // What the guitar held there before, in both voices, and the bass in the same bars.
  setFret(doc, insertBeat(doc, cursorAt(doc, guitar, barIds[1]!, 1), { value: 2 }), 9);
  setFret(doc, insertBeat(doc, { ...cursorAt(doc, guitar, barIds[2]!, 1), voice: "0:1" }, { value: 1 }), 7);
  setFret(doc, insertBeat(doc, cursorAt(doc, bass, barIds[1]!, 1), { value: 1 }), 5);
  const before = content(bass);

  const result = dropped(dropFragment(doc, { partId: guitar, barId: barIds[1]! }, guitarPhrase([1, 2, 3, 4], [5, 6, 7, 8])));

  expect(result).toEqual({ barIds: [barIds[1], barIds[2]], hints: [] });
  const after = content(guitar);
  expect(frets(after[barIds[1]!]!["0:0"])).toEqual([[1], [2], [3], [4]]);
  expect(frets(after[barIds[2]!]!["0:0"])).toEqual([[5], [6], [7], [8]]);
  // The voice the phrase has nothing in is emptied.
  expect(after[barIds[2]!]!["0:1"] ?? []).toEqual([]);
  // Bars before and after, and the other parts, are as they were.
  expect(after[barIds[0]!]).toEqual({ "0:0": [] });
  expect(after[barIds[3]!]).toEqual({ "0:0": [] });
  expect(content(bass)).toEqual(before);
});

test("the beats dropped get new ids, each time the phrase is dropped", () => {
  const { doc, barIds, guitar, content } = band(4);
  const phrase = guitarPhrase([1, 2, 3, 4]);
  dropFragment(doc, { partId: guitar, barId: barIds[0]! }, phrase);
  dropFragment(doc, { partId: guitar, barId: barIds[1]! }, phrase);
  const ids = [barIds[0]!, barIds[1]!].flatMap((barId) => content(guitar)[barId]!["0:0"]!.map((beat) => beat.id));
  expect(ids).toHaveLength(8);
  expect(new Set(ids).size).toBe(8);
  expect(ids.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
});

test("the voices are written over where they are, not replaced: the bar's content and each voice stay the same Yjs types", () => {
  const { doc, barIds, guitar } = band(2);
  setFret(doc, insertBeat(doc, cursorAt(doc, guitar, barIds[0]!, 1), { value: 1 }), 3);
  const barContent = () => (partsOf(doc).get(guitar)!.get("content") as Y.Map<Y.Map<unknown>>).get(barIds[0]!);
  const content = barContent();
  const voices = ["0:0", "0:1"].map((voice) => voiceIn(doc, { partId: guitar, barId: barIds[0]!, voice }));

  dropFragment(doc, { partId: guitar, barId: barIds[0]! }, guitarPhrase([1, 2, 3, 4]));

  expect(barContent()).toBe(content);
  ["0:0", "0:1"].forEach((voice, index) => expect(voiceIn(doc, { partId: guitar, barId: barIds[0]!, voice })).toBe(voices[index]));
  expect(voices[0]!.length).toBe(4);
});

test("a phrase dropped past the end of the score appends the bars it needs, to every part, with the time signature of the last bar, and says so", () => {
  const { doc, barIds, guitar, bass, drums, keys, content } = band(3);
  barsOf(doc).get(barIds[2]!)!.set("timeSig", { ...THREE_FOUR });

  const result = dropped(dropFragment(doc, { partId: guitar, barId: barIds[2]! }, guitarPhrase([1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12])));

  const score = docToJson(doc);
  expect(score.bars).toHaveLength(5);
  expect(score.bars.slice(0, 3).map((bar) => bar.id)).toEqual(barIds);
  const appended = score.bars.slice(3).map((bar) => bar.id);
  expect(result).toEqual({ barIds: [barIds[2], ...appended], hints: ["barsAppended"] });
  // The bars appended take the time signature of the bar before, not the phrase's.
  expect(score.bars.slice(3).map((bar) => bar.timeSig)).toEqual([THREE_FOUR, THREE_FOUR]);
  expect(frets(content(guitar)[appended[1]!]!["0:0"])).toEqual([[9], [10], [11], [12]]);
  // Every part has a place, every voice, in the bars appended.
  expect(content(bass)[appended[0]!]).toEqual({ "0:0": [] });
  expect(content(drums)[appended[0]!]).toEqual({ "0:0": [] });
  expect(content(keys)[appended[1]!]).toEqual({ "0:0": [], "1:0": [] });
});

test("a drop that would leave the score with more than MAX_BARS bars is refused whole", () => {
  const { doc, guitar, content } = band(MAX_BARS - 1);
  const last = docToJson(doc).bars.at(-1)!.id;
  const before = docToJson(doc);
  const count = transactionsOf(doc);

  expect(dropFragment(doc, { partId: guitar, barId: last }, guitarPhrase([1], [2], [3]))).toBe("tooManyBars");
  expect(count.count).toBe(0);
  expect(docToJson(doc)).toEqual(before);

  // Up to MAX_BARS is fine.
  dropped(dropFragment(doc, { partId: guitar, barId: last }, guitarPhrase([1], [2])));
  expect(docToJson(doc).bars).toHaveLength(MAX_BARS);
  expect(frets(content(guitar)[last]!["0:0"])).toEqual([[1]]);
});

test("the score's time signatures stay; a phrase that does not fit them is flagged, not rewritten", () => {
  const { doc, barIds, guitar } = band(2);
  barsOf(doc).get(barIds[0]!)!.set("timeSig", { ...THREE_FOUR });

  dropped(dropFragment(doc, { partId: guitar, barId: barIds[0]! }, guitarPhrase([1, 2, 3, 4])));

  const score = docToJson(doc);
  expect(score.bars[0]!.timeSig).toEqual(THREE_FOUR);
  expect(flagsOf(score)).toContainEqual({ kind: "overfull", partId: guitar, barId: barIds[0], voice: "0:0" });
});

test("only a part of the same kind takes a phrase", () => {
  const { doc, barIds, drums, keys } = band(2);
  const before = docToJson(doc);
  const count = transactionsOf(doc);
  expect(dropFragment(doc, { partId: drums, barId: barIds[0]! }, guitarPhrase([1, 2, 3, 4]))).toBe("otherKind");
  expect(dropFragment(doc, { partId: keys, barId: barIds[0]! }, guitarPhrase([1, 2, 3, 4]))).toBe("otherKind");
  expect(count.count).toBe(0);
  expect(docToJson(doc)).toEqual(before);
});

test("a fretted phrase of another tuning goes in fret for fret, and the shell is told the tuning differs", () => {
  const { doc, barIds, bass, guitar, content } = band(2);
  // A bass phrase on string 4 into the guitar: frets as they are, same strings.
  const phrase: BarsFragment = { kind: "fretted", tuning: [...BASS], bars: [{ timeSig: { ...COMMON }, voices: { "0:0": quarters(4, [0, 2, 3, 5]) } }] };

  const result = dropped(dropFragment(doc, { partId: guitar, barId: barIds[0]! }, phrase));

  expect(result.hints).toEqual(["tuningDiffers"]);
  expect(content(guitar)[barIds[0]!]!["0:0"]!.map((beat) => beat.notes)).toEqual([{ s4: { fret: 0 } }, { s4: { fret: 2 } }, { s4: { fret: 3 } }, { s4: { fret: 5 } }]);
  // The same tuning says nothing.
  expect(dropped(dropFragment(doc, { partId: bass, barId: barIds[0]! }, phrase)).hints).toEqual([]);
});

test("a fretted phrase that uses a string the part has not is refused; one that only has more strings is not", () => {
  const { doc, barIds, bass, content } = band(2);
  const before = docToJson(doc);
  const onFifth: BarsFragment = { kind: "fretted", tuning: [...GUITAR], bars: [{ timeSig: { ...COMMON }, voices: { "0:0": quarters(5, [3, 3, 3, 3]) } }] };
  expect(dropFragment(doc, { partId: bass, barId: barIds[0]! }, onFifth)).toBe("tooManyStrings");
  expect(docToJson(doc)).toEqual(before);

  // Six strings in its tuning, but only the fourth used: the four-string bass takes it.
  const onFourth: BarsFragment = { ...onFifth, bars: [{ timeSig: { ...COMMON }, voices: { "0:0": quarters(4, [3, 3, 3, 3]) } }] };
  expect(dropped(dropFragment(doc, { partId: bass, barId: barIds[0]! }, onFourth)).hints).toEqual(["tuningDiffers"]);
  expect(frets(content(bass)[barIds[0]!]!["0:0"])).toEqual([[3], [3], [3], [3]]);
});

test("a pitched phrase using a staff the part has not is refused; a staff the part has and the phrase has not is emptied", () => {
  const doc = new Y.Doc();
  createScore(doc, "Voices");
  const barIds = insertBars(doc, { after: null, count: 2 });
  const voice = addPart(doc, { name: "Voice", kind: "pitched" });
  const keys = addPart(doc, { name: "Keys", kind: "pitched", staves: [{ clef: "treble" }, { clef: "bass" }] });
  const content = (partId: string) => docToJson(doc).parts.find((part) => part.id === partId)!.content;
  const note = (pitch: number) => ({ value: 1 as const, dots: 0 as const, notes: { [`n${pitch}`]: {} } });
  const twoStaves: BarsFragment = {
    kind: "pitched",
    staves: [{ clef: "treble" }, { clef: "bass" }],
    bars: [{ timeSig: { ...COMMON }, voices: { "0:0": [note(72)], "1:0": [note(48)] } }],
  };
  const before = docToJson(doc);

  expect(dropFragment(doc, { partId: voice, barId: barIds[0]! }, twoStaves)).toBe("otherStaves");
  expect(docToJson(doc)).toEqual(before);

  // Two staves in the phrase, the second empty: the one-staff part takes it.
  const secondEmpty: BarsFragment = { ...twoStaves, bars: [{ timeSig: { ...COMMON }, voices: { "0:0": [note(72)], "1:0": [] } }] };
  dropped(dropFragment(doc, { partId: voice, barId: barIds[0]! }, secondEmpty));
  expect(content(voice)[barIds[0]!]!["0:0"]!.map((beat) => beat.notes)).toEqual([{ n72: {} }]);

  // The keyboard's bass staff holds a note; a phrase of one staff empties it.
  dropped(dropFragment(doc, { partId: keys, barId: barIds[1]! }, twoStaves));
  expect(content(keys)[barIds[1]!]!["1:0"]!.map((beat) => beat.notes)).toEqual([{ n48: {} }]);
  const oneStaff: BarsFragment = { kind: "pitched", staves: [{ clef: "treble" }], bars: [{ timeSig: { ...COMMON }, voices: { "0:0": [note(76)] } }] };
  dropped(dropFragment(doc, { partId: keys, barId: barIds[1]! }, oneStaff));
  expect(content(keys)[barIds[1]!]).toEqual({ "0:0": [expect.objectContaining({ notes: { n76: {} } })], "1:0": [] });
});

test("drums take a drum phrase, both voices", () => {
  const { doc, barIds, drums, content } = band(2);
  const hit = (piece: number) => ({ value: 4 as const, dots: 0 as const, notes: { [`p${piece}`]: {} } });
  const phrase: BarsFragment = { kind: "percussion", bars: [{ timeSig: { ...COMMON }, voices: { "0:0": [hit(36), hit(38), hit(36), hit(38)], "0:1": [hit(42)] } }] };
  dropped(dropFragment(doc, { partId: drums, barId: barIds[1]! }, phrase));
  expect(content(drums)[barIds[1]!]!["0:0"]!.map((beat) => Object.keys(beat.notes)[0])).toEqual(["p36", "p38", "p36", "p38"]);
  expect(content(drums)[barIds[1]!]!["0:1"]!.map((beat) => Object.keys(beat.notes)[0])).toEqual(["p42"]);
});

test("a part or bar that is gone, or a fragment that does not pass the schema, changes nothing", () => {
  const { doc, barIds, guitar } = band(2);
  const before = docToJson(doc);
  const count = transactionsOf(doc);
  expect(dropFragment(doc, { partId: "gone", barId: barIds[0]! }, guitarPhrase([1]))).toBe("gone");
  expect(dropFragment(doc, { partId: guitar, barId: "gone" }, guitarPhrase([1]))).toBe("gone");
  const withId = { ...guitarPhrase([1]), bars: [{ timeSig: { ...COMMON }, voices: { "0:0": [{ ...quarters(6, [1])[0]!, id: "x" }] } }] };
  expect(dropFragment(doc, { partId: guitar, barId: barIds[0]! }, withId as unknown as BarsFragment)).toBe("invalid");
  expect(dropFragment(doc, { partId: guitar, barId: barIds[0]! }, { ...guitarPhrase([1]), bars: [] } as unknown as BarsFragment)).toBe("invalid");
  expect(count.count).toBe(0);
  expect(docToJson(doc)).toEqual(before);
});

test("the whole drop, bars appended too, is one transaction and one undo step", () => {
  const { doc, barIds, guitar } = band(2);
  setFret(doc, insertBeat(doc, cursorAt(doc, guitar, barIds[1]!, 1), { value: 1 }), 9);
  const before = docToJson(doc);
  const undo = undoOf(doc);
  const count = transactionsOf(doc);

  dropped(dropFragment(doc, { partId: guitar, barId: barIds[1]! }, guitarPhrase([1, 2, 3, 4], [5, 6, 7, 8], [9, 9, 9, 9])));
  expect(count.count).toBe(1);
  expect(docToJson(doc).bars).toHaveLength(4);

  undo.undo();
  expect(docToJson(doc)).toEqual(before);
  expect(undo.canUndo()).toBe(false);
});

function send(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

test("beats another member types into a bar while a phrase is dropped on it stay, and the bar is flagged overfull", () => {
  const { doc: a, barIds, guitar } = band(2);
  const b = new Y.Doc();
  send(a, b);
  // Ben has typed a beat there already, which the drop knows of; then both go on at once.
  const typed = setFret(b, insertBeat(b, cursorAt(b, guitar, barIds[0]!, 1), { value: 4 }), 12);
  send(b, a);

  dropped(dropFragment(a, { partId: guitar, barId: barIds[0]! }, guitarPhrase([1, 2, 3, 4])));
  setFret(b, appendBeat(b, typed, { value: 8 }), 7);
  send(a, b);
  send(b, a);

  const score = docToJson(a);
  expect(docToJson(b)).toEqual(score);
  const beats = score.parts.find((part) => part.id === guitar)!.content[barIds[0]!]!["0:0"]!;
  // The beat the drop knew of goes with the bar's old content; the one typed meanwhile stays.
  expect(beats.map((beat) => Object.values(beat.notes)[0]!.fret!).sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 7]);
  expect(flagsOf(score)).toContainEqual({ kind: "overfull", partId: guitar, barId: barIds[0], voice: "0:0" });
});
