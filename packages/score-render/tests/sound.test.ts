// What a projected score sounds like: the MIDI alphaTab generates from it (question S6).
import * as alphaTab from "@coderline/alphatab";
import {
  addPart,
  type BeatChange,
  changeBeatAt,
  createScore,
  cursorAt,
  docToJson,
  dynamicCycle,
  insertBars,
  insertBeat,
  type NoteJSON,
  setNote,
  slapPopCycle,
  strokeCycle,
} from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { DRUM_PIECES } from "../src/drums";
import { projectScore } from "../src/projection";

const settings = new alphaTab.Settings();
const { DynamicValue } = alphaTab.model;
// alphaTab's default, which the engine keeps: let ring holds a note on in this mode only.
settings.notation.notationMode = alphaTab.NotationMode.GuitarPro;

test("alphaTab's default notation mode is the one the sound tests play in", () => {
  // The engine sets none: if alphaTab's default changes, let ring may sound otherwise in the app.
  expect(new alphaTab.Settings().notation.notationMode).toBe(alphaTab.NotationMode.GuitarPro);
});

/** The notes alphaTab would play for a score: channel, key and tick of every note-on, in order. */
function notesPlayed(doc: Y.Doc): { channel: number; key: number; tick: number }[] {
  const { score } = projectScore(docToJson(doc), settings);
  const file = new alphaTab.midi.MidiFile();
  new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(file)).generate();
  return file.events
    .filter((event): event is alphaTab.midi.NoteOnEvent => event instanceof alphaTab.midi.NoteOnEvent)
    .map((event) => ({ channel: event.channel, key: event.noteKey, tick: event.tick }))
    .sort((a, b) => a.tick - b.tick || a.key - b.key);
}

test("every drum piece of the table sounds on the percussion channel with its General MIDI key", () => {
  const doc = new Y.Doc();
  createScore(doc, "Kit");
  const pieces = Object.values(DRUM_PIECES);
  const [barId] = insertBars(doc, { after: null, count: 1, timeSig: { numerator: pieces.length, denominator: 4 } });
  const drums = addPart(doc, { name: "Drums", kind: "percussion" });
  let cursor = cursorAt(doc, drums, barId!);
  for (const piece of pieces) {
    cursor = insertBeat(doc, { ...cursor, at: "after" }, { value: 4 });
    setNote(doc, cursor, `p${piece.id}`, {});
  }
  const played = notesPlayed(doc);
  expect(played.map((note) => note.channel)).toEqual(pieces.map(() => 9));
  expect(played.map((note) => note.key)).toEqual(pieces.map((piece) => piece.midi));
  expect(played.map((note) => note.tick)).toEqual(pieces.map((_, index) => index * 960));
});

test("a pitch sounds the same however it is spelled, and a fretted note sounds its string plus its fret", () => {
  const doc = new Y.Doc();
  createScore(doc, "Pitches");
  const [barId] = insertBars(doc, { after: null, count: 1 });
  const keys = addPart(doc, { name: "Keys", kind: "pitched", program: 0 });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted" });
  let cursor = insertBeat(doc, cursorAt(doc, keys, barId!), { value: 2 });
  setNote(doc, cursor, "n61", { spell: "C#" });
  cursor = insertBeat(doc, { ...cursor, at: "after" }, { value: 2 });
  setNote(doc, cursor, "n61", { spell: "Db" });
  setNote(doc, insertBeat(doc, cursorAt(doc, guitar, barId!), { value: 1 }), "s6", { fret: 3 });
  const played = notesPlayed(doc);
  expect(played.map((note) => [note.tick, note.key])).toEqual([
    [0, 43],
    [0, 61],
    [1920, 61],
  ]);
  // The two parts do not share a channel, and neither is the percussion channel.
  expect(new Set(played.map((note) => note.channel)).size).toBe(2);
  expect(played.map((note) => note.channel)).not.toContain(9);
});

/** How a note sounds: its loudness, how long it lasts in ticks, and how many times its pitch is bent. */
interface NoteSound {
  velocity: number;
  length: number;
  bends: number;
}

/**
 * How the note on string 3 of a guitar sounds (G3, so fret 5 is MIDI 60) when it is `note`: a
 * quarter beat, followed by a quarter with the open first string, then rests.
 */
function soundOf(note: NoteJSON): NoteSound {
  const doc = new Y.Doc();
  createScore(doc, "Techniques");
  const [barId] = insertBars(doc, { after: null, count: 1 });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted" });
  const first = insertBeat(doc, cursorAt(doc, guitar, barId!), { value: 4 });
  setNote(doc, first, "s3", note);
  setNote(doc, insertBeat(doc, { ...first, at: "after" }, { value: 4 }), "s1", { fret: 0 });
  const { score } = projectScore(docToJson(doc), settings);
  const file = new alphaTab.midi.MidiFile();
  new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(file)).generate();
  const key = 55 + (note.fret ?? 0);
  const on = file.events.find((event): event is alphaTab.midi.NoteOnEvent => event instanceof alphaTab.midi.NoteOnEvent && event.noteKey === key)!;
  const off = file.events.find((event) => event instanceof alphaTab.midi.NoteOffEvent && event.noteKey === key && event.tick >= on.tick)!;
  const bends = file.events.filter((event) => event instanceof alphaTab.midi.NoteBendEvent && event.noteKey === key).length;
  return { velocity: on.noteVelocity, length: off.tick - on.tick, bends };
}

test("the techniques alphaTab plays change how the note sounds: ghost softer, accent louder, staccato, palm mute and dead shorter, let ring longer, vibrato bent", () => {
  const plain = soundOf({ fret: 5 });
  expect(plain.length).toBe(960);
  const ghost = soundOf({ fret: 5, ghost: true });
  expect(ghost.velocity).toBeLessThan(plain.velocity);
  expect({ ...ghost, velocity: plain.velocity }).toEqual(plain);
  const accent = soundOf({ fret: 5, accent: true });
  expect(accent.velocity).toBeGreaterThan(plain.velocity);
  expect({ ...accent, velocity: plain.velocity }).toEqual(plain);
  expect(soundOf({ fret: 5, staccato: true })).toEqual({ ...plain, length: 480 });
  for (const short of [soundOf({ fret: 5, palmMute: true }), soundOf({ fret: 5, dead: true })]) {
    expect(short.length).toBeLessThan(plain.length);
    expect({ ...short, length: plain.length }).toEqual(plain);
  }
  // Let ring holds the note on while the next beat plays another string, up to the rest after it.
  expect(soundOf({ fret: 5, letRing: true })).toEqual({ ...plain, length: 1920 });
  const vibrato = soundOf({ fret: 5, vibrato: true });
  expect(vibrato.bends).toBeGreaterThan(plain.bends);
  expect({ ...vibrato, bends: plain.bends }).toEqual(plain);
  // Tap is only drawn: alphaTab plays a tapped note as any other, so it is tested in the projection only.
});

test("a dead note without a fret sounds, short, on its open string", () => {
  const fretless = soundOf({ dead: true });
  expect(fretless).toEqual(soundOf({ fret: 0, dead: true }));
  expect(fretless.length).toBeLessThan(soundOf({ fret: 0 }).length);
});

/**
 * The notes alphaTab plays for one beat of a guitar, a chord of three strings (the open G, B and
 * high E), after `changes` marked it: key, velocity and tick of each note-on, lowest string first.
 */
function chordPlayed(...changes: BeatChange<unknown>[]): { key: number; velocity: number; tick: number }[] {
  const doc = new Y.Doc();
  createScore(doc, "Chord");
  const [barId] = insertBars(doc, { after: null, count: 1 });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted" });
  const beat = insertBeat(doc, cursorAt(doc, guitar, barId!), { value: 4 });
  for (const key of ["s1", "s2", "s3"]) setNote(doc, beat, key, { fret: 0 });
  for (const change of changes) changeBeatAt(doc, beat, change);
  const { score } = projectScore(docToJson(doc), settings);
  const file = new alphaTab.midi.MidiFile();
  new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(file)).generate();
  return file.events
    .filter((event): event is alphaTab.midi.NoteOnEvent => event instanceof alphaTab.midi.NoteOnEvent)
    .map((event) => ({ key: event.noteKey, velocity: event.noteVelocity, tick: event.tick }))
    .sort((a, b) => a.key - b.key);
}

test("a dynamic changes how loud the notes of its beat are, softer for pp, louder for ff, and nothing else", () => {
  const plain = chordPlayed();
  expect(plain.map((note) => [note.key, note.tick])).toEqual([
    [55, 0],
    [59, 0],
    [64, 0],
  ]);
  const velocities = (changes: number) => chordPlayed(...Array.from({ length: changes }, () => dynamicCycle)).map((note) => note.velocity);
  const [pp, p, mp, mf, f, ff] = [1, 2, 3, 4, 5, 6].map(velocities);
  // A beat without a dynamic plays as f.
  expect(f).toEqual(plain.map((note) => note.velocity));
  const loudness = [pp, p, mp, mf, f, ff].map((each) => each![0]!);
  expect([...loudness].sort((a, b) => a - b)).toEqual(loudness);
  expect(new Set(loudness).size).toBe(6);
  expect(chordPlayed(dynamicCycle).map(({ key, tick }) => [key, tick])).toEqual(plain.map(({ key, tick }) => [key, tick]));
});

test("a stroke spreads the starts of the notes of its beat: down from the lowest string, up from the highest", () => {
  const starts = (notes: { key: number; tick: number }[]) => notes.map((note) => note.tick);
  const down = starts(chordPlayed(strokeCycle));
  expect(down[0]).toBe(0);
  expect(down[0]).toBeLessThan(down[1]!);
  expect(down[1]).toBeLessThan(down[2]!);
  const up = starts(chordPlayed(strokeCycle, strokeCycle));
  expect(up[2]).toBe(0);
  expect(up[2]).toBeLessThan(up[1]!);
  expect(up[1]).toBeLessThan(up[0]!);
  // Slap and pop are only drawn: alphaTab plays them as any other beat, so they are tested in the projection only.
  expect(chordPlayed(slapPopCycle)).toEqual(chordPlayed());
});

test("a dynamic holds from its beat on, in its part and voice: the beats after it, in its bar and the next, are as soft and marked no f", () => {
  const doc = new Y.Doc();
  createScore(doc, "Softly");
  const barIds = insertBars(doc, { after: null, count: 2 });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted" });
  const plain = addPart(doc, { name: "Other", kind: "fretted" });
  let cursor = cursorAt(doc, guitar, barIds[0]!);
  const beats = [0, 1, 2].map((index) => {
    cursor = insertBeat(doc, { ...cursor, ...(index === 2 ? { barId: barIds[1]!, beatId: null } : {}), at: "after" }, { value: 4 });
    setNote(doc, cursor, "s3", { fret: index });
    return cursor;
  });
  changeBeatAt(doc, beats[0]!, dynamicCycle);
  setNote(doc, insertBeat(doc, cursorAt(doc, plain, barIds[1]!), { value: 4 }), "s3", { fret: 4 });
  const { score } = projectScore(docToJson(doc), settings);
  const drawn = [0, 0, 1].map((bar, index) => score.tracks[0]!.staves[0]!.bars[bar]!.voices[0]!.beats[bar === 0 ? index : 0]!);
  expect(drawn.map((beat) => beat.dynamics)).toEqual([DynamicValue.PP, DynamicValue.PP, DynamicValue.PP]);
  // The other part is not this one's voice: it plays at alphaTab's own f.
  expect(score.tracks[1]!.staves[0]!.bars[1]!.voices[0]!.beats[0]!.dynamics).toBe(DynamicValue.F);

  const file = new alphaTab.midi.MidiFile();
  new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(file)).generate();
  const ons = file.events.filter((event): event is alphaTab.midi.NoteOnEvent => event instanceof alphaTab.midi.NoteOnEvent);
  const velocityOf = (key: number, tick: number) => ons.find((event) => event.noteKey === key && event.tick === tick)!.noteVelocity;
  // G3, G#3 in the first bar, A3 in the next: all as soft as the pp, softer than the other part's B3 at f.
  const soft = [velocityOf(55, 0), velocityOf(56, 960), velocityOf(57, 3840)];
  expect(soft).toEqual([soft[0], soft[0], soft[0]]);
  expect(soft[0]).toBeLessThan(velocityOf(59, 3840));
});

/** Every event alphaTab generates for the guitar of a score, in a form that can be compared: what, when, which key, how loud or how bent. */
function eventsOf(doc: Y.Doc): string[] {
  const { score } = projectScore(docToJson(doc), settings);
  const file = new alphaTab.midi.MidiFile();
  new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(file)).generate();
  return file.events.flatMap((event) => {
    if (event instanceof alphaTab.midi.NoteOnEvent) return [`on ${event.tick} ${event.noteKey} ${event.noteVelocity}`];
    if (event instanceof alphaTab.midi.NoteOffEvent) return [`off ${event.tick} ${event.noteKey}`];
    if (event instanceof alphaTab.midi.NoteBendEvent) return [`bend ${event.tick} ${event.noteKey} ${event.value}`];
    return [];
  });
}

/**
 * Two quarters on string 3 of a guitar, frets 5 and 7, the second in the next bar when `across`;
 * the first with `fields`, the second with `second`.
 */
function twoNotes(fields: Partial<NoteJSON>, { across = false, second = {} }: { across?: boolean; second?: Partial<NoteJSON> } = {}): string[] {
  const doc = new Y.Doc();
  createScore(doc, "Links");
  const barIds = insertBars(doc, { after: null, count: 2 });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted" });
  const first = insertBeat(doc, cursorAt(doc, guitar, barIds[0]!), { value: 4 });
  setNote(doc, first, "s3", { fret: 5, ...fields });
  const next = across ? cursorAt(doc, guitar, barIds[1]!) : { ...first, at: "after" as const };
  setNote(doc, insertBeat(doc, next, { value: 4 }), "s3", { fret: 7, ...second });
  return eventsOf(doc);
}

test("a hammer-on, a legato slide and a shift slide sound otherwise than the same two notes plain, in a bar and across a bar line", () => {
  for (const across of [false, true]) {
    const plain = twoNotes({}, { across });
    const ons = (events: string[]) => events.filter((event) => event.startsWith("on "));
    // A hammer-on: the note it goes on to is softer, nothing else changes.
    const hammer = twoNotes({ legato: true }, { across });
    expect(hammer).not.toEqual(plain);
    const [firstOn, secondOn] = ons(hammer).map((event) => Number(event.split(" ")[3]));
    expect(secondOn).toBeLessThan(Number(ons(plain)[1]!.split(" ")[3]));
    expect(firstOn).toBe(Number(ons(plain)[0]!.split(" ")[3]));
    // A pull-off, from fret 9 down to 7, as well.
    const pullOff = ons(twoNotes({ fret: 9, legato: true }, { across })).map((event) => Number(event.split(" ")[3]));
    expect(pullOff[1]).toBeLessThan(Number(ons(twoNotes({ fret: 9 }, { across }))[1]!.split(" ")[3]));
    // A legato slide bends the first note up to the second, which is not struck again.
    const legato = twoNotes({ slideOut: "legato" }, { across });
    expect(ons(legato)).toHaveLength(1);
    expect(legato.filter((event) => event.startsWith("bend ")).length).toBeGreaterThan(plain.filter((event) => event.startsWith("bend ")).length);
    // A shift slide bends the first note too, and strikes the second.
    const shift = twoNotes({ slideOut: "shift" }, { across });
    expect(ons(shift)).toHaveLength(2);
    expect(shift).not.toEqual(plain);
    expect(shift).not.toEqual(legato);
  }
});

test("a slide out up or down, and a slide in from below or above, bend the note they are on: each its own way", () => {
  const plain = twoNotes({});
  const slides = [{ slideOut: "outUp" }, { slideOut: "outDown" }, { slideIn: "inBelow" }, { slideIn: "inAbove" }] as const;
  const sounds = slides.map((fields) => twoNotes(fields));
  for (const sound of sounds) expect(sound).not.toEqual(plain);
  expect(new Set(sounds.map((sound) => sound.join("|"))).size).toBe(slides.length);
});

test("a dangling link sounds as the note would plain: alphaTab is not told of it", () => {
  const doc = new Y.Doc();
  createScore(doc, "Dangling");
  const [barId] = insertBars(doc, { after: null, count: 1 });
  const guitar = addPart(doc, { name: "Guitar", kind: "fretted" });
  const first = insertBeat(doc, cursorAt(doc, guitar, barId!), { value: 4 });
  setNote(doc, first, "s3", { fret: 5 });
  const rest = insertBeat(doc, { ...first, at: "after" }, { value: 4 });
  setNote(doc, insertBeat(doc, { ...rest, at: "after" }, { value: 4 }), "s3", { fret: 7 });
  const plain = eventsOf(doc);
  for (const fields of [{ legato: true }, { slideOut: "legato" }, { slideOut: "shift" }] as const) {
    setNote(doc, first, "s3", { fret: 5, ...fields });
    expect(eventsOf(doc)).toEqual(plain);
  }
});
