// What a projected score sounds like: the MIDI alphaTab generates from it (question S6).
import * as alphaTab from "@coderline/alphatab";
import { addPart, createScore, cursorAt, docToJson, insertBars, insertBeat, setNote } from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { DRUM_PIECES } from "../src/drums";
import { projectScore } from "../src/projection";

const settings = new alphaTab.Settings();

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
    cursor = insertBeat(doc, cursor, { value: 4 });
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
  cursor = insertBeat(doc, cursor, { value: 2 });
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
