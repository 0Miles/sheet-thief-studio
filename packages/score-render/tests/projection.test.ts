import * as alphaTab from "@coderline/alphatab";
import { addPart, createScore, type Cursor, cursorAt, docToJson, insertBars, insertBeat, type NoteJSON, type NoteValue, setNote, stepDuration } from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { DRUM_PIECES } from "../src/drums";
import { beatIdOf, beatOf, type Projection, projectScore, replaceBars, restsFilling } from "../src/projection";

const settings = new alphaTab.Settings();
const { Duration, NoteAccidentalMode } = alphaTab.model;

function write(doc: Y.Doc, partId: string, barId: string, beats: [NoteValue, Record<string, NoteJSON>][]): Cursor {
  let cursor = cursorAt(doc, partId, barId);
  for (const [value, notes] of beats) {
    cursor = insertBeat(doc, cursor, { value });
    for (const [key, note] of Object.entries(notes)) setNote(doc, cursor, key, note);
  }
  return cursor;
}

/** Three bars (the last in 3/4) for a guitar, drums and keys; only the first bar has music. */
function band() {
  const doc = new Y.Doc();
  createScore(doc, "Demo");
  const barIds = insertBars(doc, { after: null, count: 2 });
  barIds.push(...insertBars(doc, { after: barIds[1]!, count: 1, timeSig: { numerator: 3, denominator: 4 } }));
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted", program: 29 });
  const drums = addPart(doc, { name: "Drums", kind: "percussion" });
  const keys = addPart(doc, { name: "Keys", kind: "pitched", program: 4 });
  write(doc, guitar, barIds[0]!, [
    [4, { s6: { fret: 3 }, s1: { fret: 0 } }],
    [8, {}],
  ]);
  write(doc, drums, barIds[0]!, [[4, { [`p${DRUM_PIECES.kick.id}`]: {}, [`p${DRUM_PIECES.rimShot.id}`]: {} }]]);
  write(doc, keys, barIds[0]!, [
    [2, { n61: { spell: "C#" } }],
    [2, { n61: { spell: "Db" }, n72: {} }],
  ]);
  return { doc, barIds, guitar, drums, keys };
}

/** What a voice of the alphaTab model holds, in a form that can be compared. */
function voiceOf(projection: Projection, track: number, bar: number, voice = 0) {
  return projection.score.tracks[track]!.staves[0]!.bars[bar]!.voices[voice]!.beats.map((beat) => ({
    duration: beat.duration,
    dots: beat.dots,
    rest: beat.isRest,
    notes: beat.notes.map((note) => (note.isPercussion ? `p${note.percussionArticulation}` : note.isStringed ? `${note.string}:${note.fret}` : `${note.realValue}`)),
  }));
}

test("bars and parts become master bars and tracks, in score order, each kind on its own notation", () => {
  const { doc, barIds, guitar, drums, keys } = band();
  const projection = projectScore(docToJson(doc), settings);
  const { score } = projection;
  expect(score.title).toBe("Demo");
  expect(score.masterBars).toHaveLength(3);
  expect(score.masterBars.map((bar) => [bar.timeSignatureNumerator, bar.timeSignatureDenominator])).toEqual([[4, 4], [4, 4], [3, 4]]);
  expect(score.tempo).toBe(120);
  expect(projection.barIds).toEqual(barIds);
  expect(barIds.map((id) => projection.barIndex.get(id))).toEqual([0, 1, 2]);
  expect(projection.partIds).toEqual([guitar, drums, keys]);

  const [tab, kit, piano] = score.tracks.map((track) => track.staves[0]!);
  expect(score.tracks.map((track) => track.name)).toEqual(["Guitar", "Drums", "Keys"]);
  expect([tab!.showTablature, tab!.showStandardNotation, tab!.tuning]).toEqual([true, false, [64, 59, 55, 50, 45, 40]]);
  expect([kit!.isPercussion, kit!.showTablature, kit!.showStandardNotation]).toEqual([true, false, true]);
  expect([piano!.isPercussion, piano!.showTablature, piano!.showStandardNotation]).toEqual([false, false, true]);
  // Each pitched or fretted part has channels of its own; drums play on the percussion channel.
  const channels = score.tracks.map((track) => [track.playbackInfo.primaryChannel, track.playbackInfo.secondaryChannel]);
  expect(channels).toEqual([[0, 1], [9, 9], [2, 3]]);
  expect(score.tracks.map((track) => track.playbackInfo.program)).toEqual([29, 0, 4]);
});

test("strings count from the highest, drum pieces are articulation ids, pitches keep the spelling of the score", () => {
  const { doc } = band();
  const projection = projectScore(docToJson(doc), settings);
  const first = (track: number) => projection.score.tracks[track]!.staves[0]!.bars[0]!.voices[0]!.beats;

  // String 6 of the score is alphaTab's string 1, the lowest: fret 3 on it is G2.
  const chord = first(0)[0]!.notes.map((note) => [note.string, note.fret, note.realValue]).sort();
  expect(chord).toEqual([[1, 3, 43], [6, 0, 64]]);

  const hit = first(1)[0]!.notes;
  expect(hit.map((note) => note.percussionArticulation).sort()).toEqual([36, 91]);
  // A rim shot is a piece of its own that sounds on the snare's key.
  expect(hit.map((note) => note.realValue).sort()).toEqual([36, 38]);

  const [sharp, flat] = first(2);
  expect([sharp!.notes[0]!.realValue, sharp!.notes[0]!.accidentalMode]).toEqual([61, NoteAccidentalMode.ForceSharp]);
  const spelledFlat = flat!.notes.find((note) => note.realValue === 61)!;
  expect(spelledFlat.accidentalMode).toBe(NoteAccidentalMode.ForceFlat);
  expect(flat!.notes.find((note) => note.realValue === 72)!.accidentalMode).toBe(NoteAccidentalMode.Default);
});

test("an empty bar is a whole-bar rest and a short voice is completed with rests, in the projection only", () => {
  const { doc, barIds, guitar } = band();
  const before = docToJson(doc);
  const projection = projectScore(before, settings);
  expect(voiceOf(projection, 0, 1)).toEqual([{ duration: Duration.Whole, dots: 0, rest: true, notes: [] }]);
  // A quarter and an eighth rest are written; the eighth and the half that follow are filling.
  expect(voiceOf(projection, 0, 0).map((beat) => [beat.duration, beat.rest])).toEqual([
    [Duration.Quarter, false],
    [Duration.Eighth, true],
    [Duration.Eighth, true],
    [Duration.Half, true],
  ]);
  expect(docToJson(doc)).toEqual(before);

  // Only the beats of the score have an id; the filling has none.
  const written = before.parts[0]!.content[barIds[0]!]!["0:0"]!;
  const beats = projection.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats;
  expect(beats.map((beat) => beatIdOf(projection, beat))).toEqual([written[0]!.id, written[1]!.id, null, null]);
  expect(beatOf(projection, written[1]!.id)).toBe(beats[1]);
  expect(beatOf(projection, "gone")).toBeNull();
  expect(projection.addresses.get(written[0]!.id)).toEqual({ track: 0, staff: 0, bar: 0, voice: 0, beat: 0 });
  expect(guitar).toBe(projection.partIds[0]);
});

test("rests fill a voice with the longest values that may start where they stand", () => {
  expect(restsFilling(0, 3840)).toEqual([1]);
  expect(restsFilling(960, 3840)).toEqual([4, 2]);
  expect(restsFilling(480, 3840)).toEqual([8, 4, 2]);
  expect(restsFilling(1440, 2880)).toEqual([8, 4]);
  expect(restsFilling(3840, 3840)).toEqual([]);
  // After two notes of a triplet no plain rest fits: the voice is left short.
  expect(restsFilling(640, 3840)).toEqual([]);
});

test("replacing the changed bars leaves the same model as projecting the whole score again", () => {
  const { doc, barIds, guitar, drums, keys } = band();
  const projection = projectScore(docToJson(doc), settings);
  const untouched = projection.score.tracks[0]!.staves[0]!.bars[2];

  const end = write(doc, guitar, barIds[1]!, [
    [8, { s2: { fret: 5 } }],
    [8, { s2: { fret: 7 } }],
  ]);
  write(doc, drums, barIds[1]!, [[4, { p38: {} }]]);
  stepDuration(doc, cursorAt(doc, keys, barIds[0]!), 1);
  const json = docToJson(doc);

  expect(replaceBars(projection, json, [barIds[1]!, barIds[0]!], settings)).toBe(0);
  const whole = projectScore(json, settings);
  for (const track of [0, 1, 2]) {
    for (const bar of [0, 1, 2]) expect(voiceOf(projection, track, bar)).toEqual(voiceOf(whole, track, bar));
  }
  expect([...projection.addresses.entries()].sort()).toEqual([...whole.addresses.entries()].sort());
  expect(beatOf(projection, end.beatId!)!.notes[0]!.fret).toBe(7);
  // The other bars are the same objects, and the chain of beats runs through the new bar.
  expect(projection.score.tracks[0]!.staves[0]!.bars[2]).toBe(untouched);
  const replaced = projection.score.tracks[0]!.staves[0]!.bars[1]!;
  expect(replaced.previousBar).toBe(projection.score.tracks[0]!.staves[0]!.bars[0]);
  expect(replaced.voices[0]!.beats.at(-1)!.nextBeat).toBe(untouched!.voices[0]!.beats[0]);
  expect(projection.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats.at(-1)!.nextBeat).toBe(replaced.voices[0]!.beats[0]);
});

test("a change of bars or parts is not a replacement: the whole score is projected again", () => {
  const { doc, barIds } = band();
  const projection = projectScore(docToJson(doc), settings);
  insertBars(doc, { after: barIds[2]!, count: 1 });
  expect(replaceBars(projection, docToJson(doc), [barIds[0]!], settings)).toBeNull();
  const other = band();
  expect(replaceBars(projectScore(docToJson(other.doc), settings), docToJson(other.doc), ["gone"], settings)).toBeNull();
  addPart(other.doc, { name: "Bass", kind: "fretted" });
  expect(replaceBars(projectScore(docToJson(band().doc), settings), docToJson(other.doc), [other.barIds[0]!], settings)).toBeNull();
});
