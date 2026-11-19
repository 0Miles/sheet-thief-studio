import * as alphaTab from "@coderline/alphatab";
import {
  addPart,
  type BeatJSON,
  changeBeatAt,
  createScore,
  type Cursor,
  cursorAt,
  docToJson,
  DRUM_PIECES,
  durationStep,
  DYNAMICS,
  dynamicCycle,
  flagsOf,
  insertBars,
  insertBeat,
  type NoteJSON,
  type NoteValue,
  setFret,
  setKeySig,
  setLyric,
  setNote,
  setRepeat,
  setSection,
  setText,
  setVoltas,
  slapPopCycle,
  strokeCycle,
  toggleAnacrusis,
} from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { beatIdOf, beatOf, type Projection, projectScore, replaceBars, restsFilling } from "../src/projection";

const settings = new alphaTab.Settings();
const { AccentuationType, BrushType, Duration, DynamicValue, KeySignatureType, NoteAccidentalMode, VibratoType } = alphaTab.model;

function write(doc: Y.Doc, partId: string, barId: string, beats: [NoteValue, Record<string, NoteJSON>][]): Cursor {
  let cursor = cursorAt(doc, partId, barId);
  for (const [value, notes] of beats) {
    cursor = insertBeat(doc, { ...cursor, at: "after" }, { value });
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
  // Each pitched or fretted part has a primary channel of its own, then a secondary from those left
  // over; drums play on the percussion channel (docs/spec/playback.md, section 5).
  const channels = score.tracks.map((track) => [track.playbackInfo.primaryChannel, track.playbackInfo.secondaryChannel]);
  expect(channels).toEqual([[0, 2], [9, 9], [1, 3]]);
  expect(score.tracks.map((track) => track.playbackInfo.program)).toEqual([29, 0, 4]);
});

test("each staff of a part has the clef its `staves` give it: treble G2, bass F4, treble an octave down G2 with an 8vb mark (#47)", () => {
  const { doc, barIds } = band();
  addPart(doc, { name: "Piano", kind: "pitched", staves: [{ clef: "treble" }, { clef: "bass" }] });
  addPart(doc, { name: "Guitar 8vb", kind: "pitched", staves: [{ clef: "treble-8vb" }] });
  const { score } = projectScore(docToJson(doc), settings);
  const clefs = (track: number) => score.tracks[track]!.staves.map((staff) => staff.bars.map((bar) => [bar.clef, bar.clefOttava]));
  const { Clef, Ottavia } = alphaTab.model;
  const every = (clef: alphaTab.model.Clef, ottava = Ottavia.Regular) => barIds.map(() => [clef, ottava]);
  // The tablature, the drums, the one treble staff of the keys.
  expect(clefs(0)).toEqual([every(Clef.G2)]);
  expect(clefs(1)).toEqual([every(Clef.Neutral)]);
  expect(clefs(2)).toEqual([every(Clef.G2)]);
  // Two staves for the piano, treble and bass; a treble clef an octave down for the other part.
  expect(clefs(3)).toEqual([every(Clef.G2), every(Clef.F4)]);
  expect(clefs(4)).toEqual([every(Clef.G2, Ottavia._8vb)]);
  expect(score.tracks[3]!.staves.map((staff) => [staff.showStandardNotation, staff.showTablature])).toEqual([
    [true, false],
    [true, false],
  ]);
});

test("a beat written on the second staff of a part, or in a second voice, is in its place there: the voice key decides the staff and the voice (#47)", () => {
  const { doc, barIds } = band();
  const piano = addPart(doc, { name: "Piano", kind: "pitched", staves: [{ clef: "treble" }, { clef: "bass" }] });
  const low = setNote(doc, insertBeat(doc, { ...cursorAt(doc, piano, barIds[0]!), voice: "1:0" }, { value: 2 }), "n48", {});
  const upper = setNote(doc, insertBeat(doc, { ...cursorAt(doc, piano, barIds[0]!), voice: "0:1" }, { value: 4 }), "n67", {});
  const projection = projectScore(docToJson(doc), settings);
  const track = projection.score.tracks[3]!;
  expect(track.staves).toHaveLength(2);
  expect(projection.addresses.get(low.beatId!)).toEqual({ track: 3, staff: 1, bar: 0, voice: 0, beat: 0 });
  expect(projection.addresses.get(upper.beatId!)).toEqual({ track: 3, staff: 0, bar: 0, voice: 1, beat: 0 });
  expect(beatOf(projection, low.beatId!)!.notes[0]!.realValue).toBe(48);
  expect(beatOf(projection, upper.beatId!)!.notes[0]!.realValue).toBe(67);
  // The second voice of the first staff; the second staff has one voice only.
  expect(track.staves.map((staff) => staff.bars[0]!.voices.length)).toEqual([2, 1]);
});

test("a bar replaced on a bass staff, or on a staff an octave down, keeps its clef and its octave mark: as projecting the whole score again (#47)", () => {
  const { doc, barIds } = band();
  const piano = addPart(doc, { name: "Piano", kind: "pitched", staves: [{ clef: "treble" }, { clef: "bass" }] });
  const guitar = addPart(doc, { name: "Guitar 8vb", kind: "pitched", staves: [{ clef: "treble-8vb" }] });
  const projection = projectScore(docToJson(doc), settings);
  setNote(doc, insertBeat(doc, { ...cursorAt(doc, piano, barIds[1]!), voice: "1:0" }, { value: 4 }), "n43", {});
  setNote(doc, insertBeat(doc, cursorAt(doc, guitar, barIds[1]!), { value: 4 }), "n52", {});
  const json = docToJson(doc);
  expect(replaceBars(projection, json, [barIds[1]!], settings)).toBe(1);
  const whole = projectScore(json, settings);
  const clefs = (of: Projection) => [of.score.tracks[3]!.staves[1]!.bars[1]!, of.score.tracks[4]!.staves[0]!.bars[1]!].map((bar) => [bar.clef, bar.clefOttava]);
  const { Clef, Ottavia } = alphaTab.model;
  expect(clefs(projection)).toEqual([
    [Clef.F4, Ottavia.Regular],
    [Clef.G2, Ottavia._8vb],
  ]);
  expect(clefs(projection)).toEqual(clefs(whole));
});

test("the tuning of each fretted part is written beside its own tablature, not listed above the score where those of several parts overlap", () => {
  const { doc } = band();
  addPart(doc, { name: "Bass", kind: "fretted", tuning: [43, 38, 33, 28] });
  const { score } = projectScore(docToJson(doc), settings);
  expect(score.stylesheet.tuningDisplayMode).toBe(alphaTab.model.TuningDisplayMode.Staff);
  expect(score.stylesheet.globalDisplayTuning).toBe(true);
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
  // A white key without a spelling is forced natural, as the editor finds it (#48: spelling.test.ts).
  expect(flat!.notes.find((note) => note.realValue === 72)!.accidentalMode).toBe(NoteAccidentalMode.ForceNatural);
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
  changeBeatAt(doc, cursorAt(doc, keys, barIds[0]!), durationStep(1));
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

test("each on/off technique of a fretted note becomes its alphaTab field, and a dead note without a fret is in the projection", () => {
  const doc = new Y.Doc();
  createScore(doc, "Techniques");
  const [barId] = insertBars(doc, { after: null, count: 1 });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted" });
  write(doc, guitar, barId!, [
    [8, { s1: { fret: 3, dead: true }, s2: { dead: true } }],
    [8, { s1: { fret: 3, ghost: true } }],
    [8, { s1: { fret: 3, staccato: true } }],
    [8, { s1: { fret: 3, accent: true } }],
    [8, { s1: { fret: 3, letRing: true } }],
    [8, { s1: { fret: 3, palmMute: true } }],
    [8, { s1: { fret: 3, vibrato: true } }],
    [8, { s1: { fret: 3, tap: true }, s2: { fret: 3 } }],
  ]);
  const beats = projectScore(docToJson(doc), settings).score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats;
  const fields = (note: alphaTab.model.Note) => ({
    isDead: note.isDead,
    isGhost: note.isGhost,
    isStaccato: note.isStaccato,
    accentuated: note.accentuated,
    isLetRing: note.isLetRing,
    isPalmMute: note.isPalmMute,
    vibrato: note.vibrato,
  });
  const plain = fields(beats[7]!.notes.find((note) => note.string === 5)!);
  expect(plain).toEqual({ isDead: false, isGhost: false, isStaccato: false, accentuated: AccentuationType.None, isLetRing: false, isPalmMute: false, vibrato: VibratoType.None });
  const onString1 = (beat: number) => fields(beats[beat]!.notes.find((note) => note.string === 6)!);
  expect(onString1(0)).toEqual({ ...plain, isDead: true });
  expect(onString1(1)).toEqual({ ...plain, isGhost: true });
  expect(onString1(2)).toEqual({ ...plain, isStaccato: true });
  expect(onString1(3)).toEqual({ ...plain, accentuated: AccentuationType.Normal });
  expect(onString1(4)).toEqual({ ...plain, isLetRing: true });
  expect(onString1(5)).toEqual({ ...plain, isPalmMute: true });
  expect(onString1(6)).toEqual({ ...plain, vibrato: VibratoType.Slight });
  // The dead note on string 2 has no fret: it is drawn as an X on that string.
  const fretless = beats[0]!.notes.find((note) => note.string === 5)!;
  expect([fretless.isDead, fretless.fret]).toEqual([true, 0]);
  // Tap is the beat's: any note of it tapped taps the beat.
  expect(beats.map((beat) => beat.tap)).toEqual([false, false, false, false, false, false, false, true]);
});

test("the markings of a beat become its alphaTab fields: stroke the brush, slap, pop, dynamic and text; a beat without them has alphaTab's own", () => {
  const doc = new Y.Doc();
  createScore(doc, "Beat markings");
  const [barId] = insertBars(doc, { after: null, count: 1 });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted" });
  const keys = addPart(doc, { name: "Keys", kind: "pitched" });
  const chord = { s1: { fret: 0 }, s2: { fret: 1 }, s3: { fret: 0 } };
  write(doc, guitar, barId!, [
    [8, chord],
    [8, chord],
    [8, chord],
    [8, chord],
    [8, chord],
    [8, chord],
  ]);
  const on = (index: number) => {
    const beatId = docToJson(doc).parts[0]!.content[barId!]!["0:0"]![index]!.id;
    return { ...cursorAt(doc, guitar, barId!), beatId };
  };
  changeBeatAt(doc, on(1), strokeCycle);
  changeBeatAt(doc, on(2), strokeCycle);
  changeBeatAt(doc, on(2), strokeCycle);
  changeBeatAt(doc, on(3), slapPopCycle);
  changeBeatAt(doc, on(4), slapPopCycle);
  changeBeatAt(doc, on(4), slapPopCycle);
  for (let step = 0; step < 4; step++) changeBeatAt(doc, on(5), dynamicCycle);
  setText(doc, on(5), "Am7");
  const pitched = write(doc, keys, barId!, [[2, { n60: {} }]]);
  changeBeatAt(doc, pitched, dynamicCycle);
  setText(doc, pitched, "C");

  const { score } = projectScore(docToJson(doc), settings);
  const beats = score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats;
  const fields = (beat: alphaTab.model.Beat) => ({ brushType: beat.brushType, slap: beat.slap, pop: beat.pop, dynamics: beat.dynamics, text: beat.text });
  const plain = fields(beats[0]!);
  expect(plain).toEqual({ brushType: BrushType.None, slap: false, pop: false, dynamics: DynamicValue.F, text: null });
  expect(fields(beats[1]!)).toEqual({ ...plain, brushType: BrushType.BrushDown });
  expect(fields(beats[2]!)).toEqual({ ...plain, brushType: BrushType.BrushUp });
  expect(fields(beats[3]!)).toEqual({ ...plain, slap: true });
  expect(fields(beats[4]!)).toEqual({ ...plain, pop: true });
  expect(fields(beats[5]!)).toEqual({ ...plain, dynamics: DynamicValue.MF, text: "Am7" });
  // A strummed beat takes time to strum: without it alphaTab would sound every string at once.
  expect(beats[1]!.brushDuration).toBeGreaterThan(0);
  expect(beats[0]!.brushDuration).toBe(0);
  // The notes are as loud as their beat.
  expect(beats[5]!.notes.map((note) => note.dynamics)).toEqual([DynamicValue.MF, DynamicValue.MF, DynamicValue.MF]);
  const staff = score.tracks[1]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!;
  expect([staff.dynamics, staff.text]).toEqual([DynamicValue.PP, "C"]);
});

test("a syllable becomes the beat's one line of lyrics, its - kept; an empty one (a melisma) and none are no lyrics, not [\"\"] (#50)", () => {
  const { doc, barIds, keys } = band();
  write(doc, keys, barIds[1]!, [
    [4, { n60: {} }],
    [4, { n62: {} }],
    [4, { n64: {} }],
    [4, { n65: {} }],
  ]);
  const beatIds = docToJson(doc).parts[2]!.content[barIds[1]!]!["0:0"]!.map((beat) => beat.id);
  const on = (index: number): Cursor => ({ ...cursorAt(doc, keys, barIds[1]!), beatId: beatIds[index]!, at: "on" });
  setLyric(doc, on(0), "Hel-");
  setLyric(doc, on(1), "lo");
  setLyric(doc, on(2), "");
  const { score } = projectScore(docToJson(doc), settings);
  const beats = score.tracks[2]!.staves[0]!.bars[1]!.voices[0]!.beats;
  expect(beats.map((beat) => beat.lyrics)).toEqual([["Hel-"], ["lo"], null, null]);
});

test("replacing a bar whose dynamic changed rebuilds the bars after it up to the next written dynamic in that voice", () => {
  const doc = new Y.Doc();
  createScore(doc, "Dynamics");
  const barIds = insertBars(doc, { after: null, count: 4 });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted" });
  const first = barIds.map((barId) => write(doc, guitar, barId, [[2, { s1: { fret: 0 } }]]));
  // The third bar has a dynamic of its own: the fourth goes on from it whatever the first says.
  for (let step = 0; step < 6; step++) changeBeatAt(doc, first[2]!, dynamicCycle);
  const projection = projectScore(docToJson(doc), settings);
  const bars = () => projection.score.tracks[0]!.staves[0]!.bars;
  const fourth = bars()[3];
  const dynamics = () => bars().map((bar) => bar.voices[0]!.beats.map((beat) => beat.dynamics));
  expect(dynamics()).toEqual([
    [DynamicValue.F, DynamicValue.F],
    [DynamicValue.F, DynamicValue.F],
    [DynamicValue.FF, DynamicValue.FF],
    [DynamicValue.FF, DynamicValue.FF],
  ]);

  changeBeatAt(doc, first[0]!, dynamicCycle);
  const json = docToJson(doc);
  expect(replaceBars(projection, json, [barIds[0]!], settings)).toBe(0);
  // The second bar, unchanged in the score, is played and drawn at the pp of the first; the rests filling a bar too.
  expect(dynamics()).toEqual([
    [DynamicValue.PP, DynamicValue.PP],
    [DynamicValue.PP, DynamicValue.PP],
    [DynamicValue.FF, DynamicValue.FF],
    [DynamicValue.FF, DynamicValue.FF],
  ]);
  expect(bars()[1]!.voices[0]!.beats[0]!.notes[0]!.dynamics).toBe(DynamicValue.PP);
  expect(bars()[3]).toBe(fourth);
  const whole = projectScore(json, settings);
  expect(whole.score.tracks[0]!.staves[0]!.bars.map((bar) => bar.voices[0]!.beats.map((beat) => beat.dynamics))).toEqual(dynamics());
});

/** Whether each beat of the first voice of the first part's first staff is drawn with a dynamic, by bar (null: a rest). */
const drawnDynamics = (score: alphaTab.model.Score) => score.tracks[0]!.staves[0]!.bars.map((bar) => bar.voices[0]!.beats.map((beat) => (beat.isRest ? null : beat.showDynamics)));

test("replacing a bar that leaves a dynamic on a rest to draw, or no longer, rebuilds the bar after it, where it is drawn, though the dynamic in force is the same (#97)", () => {
  const doc = new Y.Doc();
  createScore(doc, "Dynamics");
  const barIds = insertBars(doc, { after: null, count: 3 });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted" });
  const fret = { s1: { fret: 0 } };
  const marked = write(doc, guitar, barIds[0]!, [[2, fret], [2, {}]]);
  write(doc, guitar, barIds[1]!, [[2, {}], [2, fret]]);
  write(doc, guitar, barIds[2]!, [[1, fret]]);
  const projection = projectScore(docToJson(doc), settings);
  const bars = () => projection.score.tracks[0]!.staves[0]!.bars;
  const drawn = drawnDynamics;
  const third = bars()[2];
  // Whether each beat that is not a rest is drawn with a dynamic (null: a rest).
  expect(drawn(projection.score)).toEqual([[false, null], [null, false], [false]]);

  // An f on the rest: the dynamic in force is f before and after, but the second bar draws it now.
  for (let step = 0; step < 5; step++) changeBeatAt(doc, marked, dynamicCycle);
  let json = docToJson(doc);
  expect(json.parts[0]!.content[barIds[0]!]!["0:0"]![1]!.dynamic).toBe("f");
  expect(replaceBars(projection, json, [barIds[0]!], settings)).toBe(0);
  expect(drawn(projection.score)).toEqual([[false, null], [null, true], [false]]);
  expect(bars()[2]).toBe(third);
  expect(drawn(projectScore(json, settings).score)).toEqual(drawn(projection.score));

  // Taken off again (ff, then none): the second bar draws nothing.
  for (let step = 0; step < 2; step++) changeBeatAt(doc, marked, dynamicCycle);
  json = docToJson(doc);
  expect(replaceBars(projection, json, [barIds[0]!], settings)).toBe(0);
  expect(drawn(projection.score)).toEqual([[false, null], [null, false], [false]]);
  expect(drawn(projectScore(json, settings).score)).toEqual(drawn(projection.score));
});

test("a dynamic on a rest to draw goes on past bars of rests only, and back, as a note in one of them is written and taken off (#97)", () => {
  const doc = new Y.Doc();
  createScore(doc, "Dynamics");
  const barIds = insertBars(doc, { after: null, count: 5 });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted" });
  const marked = write(doc, guitar, barIds[0]!, [[2, { s1: { fret: 0 } }], [2, {}]]);
  write(doc, guitar, barIds[4]!, [[1, { s1: { fret: 0 } }]]);
  const projection = projectScore(docToJson(doc), settings);
  /** Rebuild `barId` in the projection: drawn as the whole score projected again is. */
  const replace = (barId: string) => {
    const json = docToJson(doc);
    expect(replaceBars(projection, json, [barId], settings)).not.toBeNull();
    expect(drawnDynamics(projection.score)).toEqual(drawnDynamics(projectScore(json, settings).score));
    return drawnDynamics(projection.score);
  };

  // A pp on the rest of the first bar: three bars of rests, then the note of the fifth draws it.
  changeBeatAt(doc, marked, dynamicCycle);
  expect(replace(barIds[0]!)).toEqual([[false, null], [null], [null], [null], [true]]);
  // A note in the third bar draws it there, and the fifth no longer.
  const third = write(doc, guitar, barIds[2]!, [[2, {}], [2, { s1: { fret: 2 } }]]);
  expect(replace(barIds[2]!)).toEqual([[false, null], [null], [null, true], [null], [false]]);
  // Taken off again, the fifth draws it.
  setFret(doc, { ...third, line: 1 }, null);
  expect(replace(barIds[2]!)).toEqual([[false, null], [null], [null, null], [null], [true]]);
  // An ff over it, then no dynamic at all.
  for (let step = 0; step < 5; step++) changeBeatAt(doc, marked, dynamicCycle);
  expect(replace(barIds[0]!)).toEqual([[false, null], [null], [null, null], [null], [true]]);
  changeBeatAt(doc, marked, dynamicCycle);
  expect(replace(barIds[0]!)).toEqual([[false, null], [null], [null, null], [null], [false]]);
});

test("rebuilding bars one change at a time draws the dynamics, and plays them, as projecting the whole score again: many random changes (#97)", () => {
  // A fixed seed: the same changes every run.
  let seed = 7919;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!;
  let ids = 0;
  /** Up to four quarters, most of them rests, some with a dynamic. */
  const beats = (): BeatJSON[] =>
    Array.from({ length: Math.floor(random() * 5) }, () => {
      const beat: BeatJSON = { id: `b${ids++}`, value: 4, dots: 0, notes: random() < 0.8 ? {} : { s3: { fret: 3 } } };
      if (random() < 0.3) beat.dynamic = pick(DYNAMICS);
      return beat;
    });
  const doc = new Y.Doc();
  createScore(doc, "Random");
  const barIds = insertBars(doc, { after: null, count: 6 });
  addPart(doc, { name: "Guitar", kind: "fretted" });
  addPart(doc, { name: "Bass", kind: "fretted" });
  // Every voice in every bar from the start, though empty: a change never adds one (that projects the whole score again).
  const voices = [["0:0", "0:1"], ["0:0"]] as const;
  let json = docToJson(doc);
  json.parts.forEach((part, index) => {
    for (const barId of barIds) part.content[barId] = Object.fromEntries(voices[index]!.map((voice) => [voice, beats()]));
  });
  const projection = projectScore(json, settings);
  /** What each beat of every voice is drawn and played with: rest or not, a dynamic drawn, the dynamic in force. */
  const seen = (score: alphaTab.model.Score) =>
    score.tracks.map((track) => track.staves[0]!.bars.map((bar) => bar.voices.map((voice) => voice.beats.map((beat) => `${beat.isRest ? "-" : "x"}${beat.showDynamics ? "!" : ""}${beat.dynamics}`))));
  for (let step = 0; step < 120; step++) {
    json = structuredClone(json);
    const part = Math.floor(random() * 2);
    const barId = pick(barIds);
    const voice = pick(voices[part]!);
    const content = json.parts[part]!.content[barId]!;
    const written = content[voice]!;
    const beat = written.length > 0 && random() < 0.6 ? pick(written) : undefined;
    if (beat === undefined) content[voice] = beats();
    else if (random() < 0.5) {
      if (beat.dynamic) delete beat.dynamic;
      else beat.dynamic = pick(DYNAMICS);
    } else beat.notes = Object.keys(beat.notes).length > 0 ? {} : { s3: { fret: 5 } };
    expect(replaceBars(projection, json, [barId], settings), `step ${step}`).not.toBeNull();
    expect(seen(projection.score), `step ${step}`).toEqual(seen(projectScore(json, settings).score));
  }
});

/** A guitar of bars of 4/4, one for each entry of `bars`, each bar's beats given as frets on string 3 (null: a rest), with these fields on its notes. */
function linked(bars: [number | null, Partial<NoteJSON>?][][]) {
  const doc = new Y.Doc();
  createScore(doc, "Links");
  const barIds = insertBars(doc, { after: null, count: bars.length });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted" });
  bars.forEach((beats, bar) => write(doc, guitar, barIds[bar]!, beats.map(([fret, fields]): [NoteValue, Record<string, NoteJSON>] => [4, fret === null ? {} : { s3: { fret, ...fields } }])));
  /** The note on string 3 (alphaTab's 4) of a beat, null on a rest. */
  const noteOf = (projection: Projection, bar: number, beat: number) => projection.score.tracks[0]!.staves[0]!.bars[bar]!.voices[0]!.beats[beat]!.getNoteOnString(4);
  return { doc, barIds, guitar, noteOf };
}

test("legato and the slides become their alphaTab fields, and a link goes on to the note after it on its string, in its bar or the next", () => {
  const { doc, noteOf } = linked([
    [
      [5, { legato: true }],
      [7, { slideOut: "legato" }],
      [9, { slideOut: "shift" }],
      [11, { legato: true }],
    ],
    [
      [12, { slideOut: "outUp", slideIn: "inBelow" }],
      [12, { slideOut: "outDown", slideIn: "inAbove" }],
      [12],
      [12],
    ],
  ]);
  const projection = projectScore(docToJson(doc), settings);
  const { SlideInType, SlideOutType } = alphaTab.model;
  const at = (bar: number, beat: number) => noteOf(projection, bar, beat)!;
  expect([at(0, 0).isHammerPullOrigin, at(0, 0).hammerPullDestination]).toEqual([true, at(0, 1)]);
  expect(at(0, 1).hammerPullOrigin).toBe(at(0, 0));
  expect([at(0, 1).slideOutType, at(0, 1).slideTarget]).toEqual([SlideOutType.Legato, at(0, 2)]);
  expect([at(0, 2).slideOutType, at(0, 2).slideTarget]).toEqual([SlideOutType.Shift, at(0, 3)]);
  // Across the bar line: the last beat of the first bar goes on to the first of the second.
  expect([at(0, 3).isHammerPullOrigin, at(0, 3).hammerPullDestination]).toEqual([true, at(1, 0)]);
  expect([at(1, 0).slideOutType, at(1, 0).slideInType]).toEqual([SlideOutType.OutUp, SlideInType.IntoFromBelow]);
  expect([at(1, 1).slideOutType, at(1, 1).slideInType]).toEqual([SlideOutType.OutDown, SlideInType.IntoFromAbove]);
  expect([at(1, 2).isHammerPullOrigin, at(1, 2).slideOutType, at(1, 2).slideInType]).toEqual([false, SlideOutType.None, SlideInType.None]);
});

test("a dangling link goes on to nothing, though alphaTab would look on past a rest: the flag says it", () => {
  const { doc, noteOf } = linked([
    [
      [5, { legato: true }],
      [null],
      [7, { slideOut: "shift" }],
      [null],
    ],
    [[9], [9], [9], [9]],
  ]);
  const json = docToJson(doc);
  const projection = projectScore(json, settings);
  expect([noteOf(projection, 0, 0)!.isHammerPullOrigin, noteOf(projection, 0, 0)!.hammerPullDestination]).toEqual([false, null]);
  expect([noteOf(projection, 0, 2)!.slideOutType, noteOf(projection, 0, 2)!.slideTarget]).toEqual([alphaTab.model.SlideOutType.None, null]);
  expect(noteOf(projection, 1, 0)!.hammerPullOrigin).toBeNull();
  expect(flagsOf(json).map((flag) => flag.kind)).toEqual(["danglingLink", "danglingLink"]);
});

/** How the links of a projection run: each note's bar, beat, fret and where its link goes, for comparing. */
function linksIn(projection: Projection) {
  return projection.score.tracks[0]!.staves[0]!.bars.flatMap((bar) =>
    bar.voices[0]!.beats.flatMap((beat) =>
      beat.notes.map((note) => {
        const where = (other: alphaTab.model.Note | null) => other && [other.beat.voice.bar.index, other.beat.index, other.fret];
        return [bar.index, beat.index, note.fret, note.isHammerPullOrigin, note.slideOutType, where(note.hammerPullDestination), where(note.hammerPullOrigin), where(note.slideTarget), where(note.slideOrigin)];
      }),
    ),
  );
}

test("replacing a bar a link goes into, or out of, across a bar line, rebuilds the bar on the other side too: the same links as projecting the whole score", () => {
  const { doc, barIds, guitar, noteOf } = linked([
    [[1], [2], [3], [4, { legato: true }]],
    [[5, { slideOut: "legato" }], [6], [7], [8, { slideOut: "shift" }]],
    [[9], [10], [11], [12]],
    [[13], [14], [15], [16]],
  ]);
  const projection = projectScore(docToJson(doc), settings);
  const bars = () => projection.score.tracks[0]!.staves[0]!.bars;
  const last = bars()[3];
  const check = (changed: number, first: number) => {
    const json = docToJson(doc);
    expect(replaceBars(projection, json, [barIds[changed]!], settings)).toBe(first);
    expect(linksIn(projection)).toEqual(linksIn(projectScore(json, settings)));
  };
  // A new fret where the link from the first bar lands: the first bar is rebuilt to go on to it.
  setNote(doc, cursorAt(doc, guitar, barIds[1]!), "s3", { fret: 0, slideOut: "legato" });
  check(1, 0);
  expect(noteOf(projection, 0, 3)!.hammerPullDestination).toBe(noteOf(projection, 1, 0));
  // The note the second bar's slide goes on to is taken away, then put back: the second bar is
  // rebuilt each time, and so the first, whose link goes into it.
  const third = cursorAt(doc, guitar, barIds[2]!, 3);
  setNote(doc, third, "s3", null);
  check(2, 0);
  expect(noteOf(projection, 1, 3)!.slideOutType).toBe(alphaTab.model.SlideOutType.None);
  setNote(doc, third, "s3", { fret: 2 });
  check(2, 0);
  expect(noteOf(projection, 1, 3)!.slideTarget).toBe(noteOf(projection, 2, 0));
  // A link taken away: the bar it went into no longer goes on from it.
  const beatId = docToJson(doc).parts[0]!.content[barIds[0]!]!["0:0"]![3]!.id;
  setNote(doc, { ...cursorAt(doc, guitar, barIds[0]!, 3), beatId }, "s3", { fret: 4 });
  check(0, 0);
  expect(noteOf(projection, 1, 0)!.hammerPullOrigin).toBeNull();
  // The last bar, which no link reaches, was never rebuilt.
  expect(bars()[3]).toBe(last);
});

test("each preset bend becomes its alphaTab bend type and the bend points of its shape, in quarter tones, up the semitones set", () => {
  const doc = new Y.Doc();
  createScore(doc, "Bends");
  const [barId] = insertBars(doc, { after: null, count: 1 });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted" });
  write(doc, guitar, barId!, [
    [4, { s3: { fret: 7, bend: { type: "bend", semitones: 2 } } }],
    [4, { s3: { fret: 7, bend: { type: "bendRelease", semitones: 1 } } }],
    [4, { s3: { fret: 7, bend: { type: "preBend", semitones: 4 } } }],
    [4, { s3: { fret: 7, bend: { type: "preBendRelease", semitones: 3 } } }],
  ]);
  const projection = projectScore(docToJson(doc), settings);
  const notes = projection.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats.map((beat) => beat.getNoteOnString(4)!);
  const { BendType } = alphaTab.model;
  expect(notes.map((note) => [note.bendType, note.bendPoints!.map((point) => [point.offset, point.value])])).toEqual([
    // Up in the first quarter of the note, then held.
    [BendType.Bend, [[0, 0], [15, 4]]],
    // Up in the first quarter, held, and down again in the last.
    [BendType.BendRelease, [[0, 0], [15, 2], [45, 2], [60, 0]]],
    // Bent before it is struck, and held.
    [BendType.Prebend, [[0, 8], [60, 8]]],
    // Bent before it is struck, and let down in the first quarter.
    [BendType.PrebendRelease, [[0, 6], [15, 0]]],
  ]);
  expect(notes.map((note) => note.maxBendPoint!.value)).toEqual([4, 2, 8, 6]);
});

test("a note with no bend has none in alphaTab", () => {
  const { doc } = band();
  const note = projectScore(docToJson(doc), settings).score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
  expect([note.bendType, note.hasBend, note.bendPoints]).toEqual([alphaTab.model.BendType.None, false, null]);
});

test("each harmonic becomes its alphaTab harmonic type: natural at the node of its fret, pinch and artificial an octave over the fret", () => {
  const doc = new Y.Doc();
  createScore(doc, "Harmonics");
  const [barId] = insertBars(doc, { after: null, count: 1 });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted" });
  write(doc, guitar, barId!, [
    [4, { s3: { fret: 12, harmonic: "natural" } }],
    [4, { s3: { fret: 7, harmonic: "natural" } }],
    [4, { s3: { fret: 5, harmonic: "pinch" } }],
    [4, { s3: { fret: 5, harmonic: "artificial" } }],
  ]);
  const projection = projectScore(docToJson(doc), settings);
  const notes = projection.score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats.map((beat) => beat.getNoteOnString(4)!);
  const { HarmonicType } = alphaTab.model;
  expect(notes.map((note) => [note.harmonicType, note.harmonicValue, note.fret])).toEqual([
    [HarmonicType.Natural, 12, 12],
    [HarmonicType.Natural, 7, 7],
    [HarmonicType.Pinch, 12, 5],
    [HarmonicType.Artificial, 12, 5],
  ]);
});

test("a note with no harmonic has none in alphaTab", () => {
  const { doc } = band();
  const note = projectScore(docToJson(doc), settings).score.tracks[0]!.staves[0]!.bars[0]!.voices[0]!.beats[0]!.notes[0]!;
  expect([note.harmonicType, note.harmonicValue, note.isHarmonic]).toEqual([alphaTab.model.HarmonicType.None, 0, false]);
});

test("the marks of the bars become their master bar fields: section, repeat start and count, alternate endings, pickup", () => {
  const { doc, barIds, guitar } = band();
  const at = (bar: number) => cursorAt(doc, guitar, barIds[bar]!);
  setSection(doc, at(0), "前奏");
  toggleAnacrusis(doc, at(0));
  setRepeat(doc, at(1), { kind: "bars", partId: guitar, anchorBarId: barIds[1]!, focusBarId: barIds[2]! }, { times: 3 });
  setVoltas(doc, at(1), null, [1, 3]);
  setVoltas(doc, at(2), null, [2]);
  const { score } = projectScore(docToJson(doc), settings);
  const fields = score.masterBars.map((bar) => ({
    section: bar.section?.text ?? null,
    start: bar.isRepeatStart,
    count: bar.repeatCount,
    endings: bar.alternateEndings,
    pickup: bar.isAnacrusis,
  }));
  expect(fields).toEqual([
    { section: "前奏", start: false, count: 0, endings: 0, pickup: true },
    { section: null, start: true, count: 0, endings: 0b101, pickup: false },
    { section: null, start: false, count: 3, endings: 0b010, pickup: false },
  ]);
  expect(score.masterBars[2]!.isRepeatEnd).toBe(true);
});

test("a key holds from its bar on, on every staff but the drums', in its mode", () => {
  const { doc, barIds, guitar } = band();
  setKeySig(doc, cursorAt(doc, guitar, barIds[1]!), { fifths: -3, mode: "minor" });
  const projection = projectScore(docToJson(doc), settings);
  const keysOf = (track: number) => projection.score.tracks[track]!.staves[0]!.bars.map((bar) => [bar.keySignature, bar.keySignatureType]);
  const minor = [-3, KeySignatureType.Minor];
  expect(keysOf(0)).toEqual([[0, KeySignatureType.Major], minor, minor]);
  expect(keysOf(2)).toEqual([[0, KeySignatureType.Major], minor, minor]);
  expect(keysOf(1)).toEqual([[0, KeySignatureType.Major], [0, KeySignatureType.Major], [0, KeySignatureType.Major]]);

  // A bar replaced takes the key in force where it is.
  write(doc, guitar, barIds[2]!, [[4, { s2: { fret: 1 } }]]);
  const json = docToJson(doc);
  expect(replaceBars(projection, json, [barIds[2]!], settings)).toBe(2);
  expect(keysOf(0)).toEqual([[0, KeySignatureType.Major], minor, minor]);
  expect(voiceOf(projection, 0, 2)).toEqual(voiceOf(projectScore(json, settings), 0, 2));
});

test("a pickup bar is as long as its longest voice in any part: shorter voices are filled to it, an empty one with rests of that length", () => {
  const { doc, barIds, guitar, drums, keys } = band();
  toggleAnacrusis(doc, cursorAt(doc, keys, barIds[0]!));
  // The guitar holds a quarter and an eighth, the drums a quarter, the keys two halves: the keys fill the bar.
  let projection = projectScore(docToJson(doc), settings);
  expect(projection.score.masterBars[0]!.calculateDuration()).toBe(3840);
  // Without the keys' bar, the guitar's quarter and eighth are the longest: a dotted quarter.
  const emptied = docToJson(doc);
  emptied.parts[2]!.content[barIds[0]!] = { "0:0": [] };
  projection = projectScore(emptied, settings);
  expect(projection.score.masterBars[0]!.calculateDuration()).toBe(1440);
  expect(voiceOf(projection, 0, 0).map((beat) => [beat.duration, beat.rest])).toEqual([
    [Duration.Quarter, false],
    [Duration.Eighth, true],
  ]);
  expect(voiceOf(projection, 1, 0).map((beat) => [beat.duration, beat.rest])).toEqual([
    [Duration.Quarter, false],
    [Duration.Eighth, true],
  ]);
  expect(voiceOf(projection, 2, 0).map((beat) => [beat.duration, beat.rest])).toEqual([
    [Duration.Quarter, true],
    [Duration.Eighth, true],
  ]);
  // The bar after starts right after it.
  expect(projection.score.masterBars[1]!.start).toBe(1440);
  expect(drums).toBe(projection.partIds[1]);
  expect(guitar).toBe(projection.partIds[0]);
});

test("a pickup bar with nothing in it is as long as its time signature", () => {
  const doc = new Y.Doc();
  createScore(doc, "Empty pickup");
  const [barId] = insertBars(doc, { after: null, count: 2, timeSig: { numerator: 3, denominator: 4 } });
  const keys = addPart(doc, { name: "Keys", kind: "pitched" });
  toggleAnacrusis(doc, cursorAt(doc, keys, barId!));
  const projection = projectScore(docToJson(doc), settings);
  expect(projection.score.masterBars[0]!.isAnacrusis).toBe(true);
  expect(projection.score.masterBars[0]!.calculateDuration()).toBe(2880);
  expect(voiceOf(projection, 0, 0).map((beat) => [beat.duration, beat.rest])).toEqual([
    [Duration.Half, true],
    [Duration.Quarter, true],
  ]);
});

test("a change that keeps the length of a pickup bar replaces its bars like any other: the same model as projecting the whole score again", () => {
  const { doc, barIds, guitar, keys } = band();
  toggleAnacrusis(doc, cursorAt(doc, keys, barIds[0]!));
  const projection = projectScore(docToJson(doc), settings);
  const score = projection.score;
  // The keys fill the bar; the guitar's quarter and eighth get one more eighth, still shorter.
  write(doc, guitar, barIds[0]!, [[8, { s2: { fret: 5 } }]]);
  const json = docToJson(doc);
  expect(replaceBars(projection, json, [barIds[0]!], settings)).toBe(0);
  expect(projection.score).toBe(score);
  const whole = projectScore(json, settings);
  for (const track of [0, 1, 2]) expect(voiceOf(projection, track, 0)).toEqual(voiceOf(whole, track, 0));
  const lengths = (bars: alphaTab.model.MasterBar[]) => bars.map((bar) => [bar.calculateDuration(), bar.start]);
  expect(lengths(score.masterBars)).toEqual(lengths(whole.score.masterBars));
});

test("a change of the length of a pickup bar is not a replacement: where the bars after it start changes with it", () => {
  const { doc, barIds, keys } = band();
  toggleAnacrusis(doc, cursorAt(doc, keys, barIds[0]!));
  const projection = projectScore(docToJson(doc), settings);
  // The keys' first half becomes a quarter: the longest voice, and the bar, a quarter shorter.
  changeBeatAt(doc, cursorAt(doc, keys, barIds[0]!), durationStep(1));
  expect(replaceBars(projection, docToJson(doc), [barIds[0]!], settings)).toBeNull();
  // Projected again, any bar after it is replaced as before.
  write(doc, keys, barIds[1]!, [[4, { n60: {} }]]);
  const fresh = projectScore(docToJson(doc), settings);
  write(doc, keys, barIds[2]!, [[4, { n62: {} }]]);
  expect(replaceBars(fresh, docToJson(doc), [barIds[2]!], settings)).toBe(2);
});
