import * as alphaTab from "@coderline/alphatab";
import {
  addPart,
  changeBeatAt,
  createScore,
  type Cursor,
  cursorAt,
  docToJson,
  dynamicCycle,
  flagsOf,
  insertBars,
  insertBeat,
  type NoteJSON,
  type NoteValue,
  setNote,
  setText,
  slapPopCycle,
  stepDuration,
  strokeCycle,
} from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { DRUM_PIECES } from "../src/drums";
import { beatIdOf, beatOf, type Projection, projectScore, replaceBars, restsFilling } from "../src/projection";

const settings = new alphaTab.Settings();
const { AccentuationType, BrushType, Duration, DynamicValue, NoteAccidentalMode, VibratoType } = alphaTab.model;

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
