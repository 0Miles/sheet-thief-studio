// What a projected score sounds like: the MIDI alphaTab generates from it (question S6).
import * as alphaTab from "@coderline/alphatab";
import { addPart, createScore, cursorAt, docToJson, insertBars, insertBeat, type NoteJSON, setNote } from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { DRUM_PIECES } from "../src/drums";
import { projectScore } from "../src/projection";

const settings = new alphaTab.Settings();
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
