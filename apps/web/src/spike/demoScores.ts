// Scores the spike page starts from. M0 only: real scores will be created by the server.
import { addPart, createScore, type Cursor, cursorAt, insertBars, insertBeat, LOCAL, type NewPart, type NoteJSON, type NoteValue, setNote } from "@studio/score-model";
import { DRUM_PIECES } from "@studio/score-render";
import type * as Y from "yjs";

const BASS_TUNING = [43, 38, 33, 28];

/** The parts of the demo band, in the order they are added. */
const BAND: NewPart[] = [
  { name: "Guitar 1", kind: "fretted", program: 29 },
  { name: "Drums", kind: "percussion", program: 0 },
  { name: "Keys", kind: "pitched", program: 0 },
  { name: "Bass", kind: "fretted", tuning: BASS_TUNING, program: 33 },
  { name: "Guitar 2", kind: "fretted", program: 30 },
];

type Notes = Record<string, NoteJSON>;

/** Append beats to a bar of a part, each with its notes. */
function write(doc: Y.Doc, partId: string, barId: string, beats: [NoteValue, Notes][]): void {
  let cursor: Cursor = cursorAt(doc, partId, barId);
  for (const [value, notes] of beats) {
    cursor = insertBeat(doc, { ...cursor, at: "after" }, { value });
    for (const [key, note] of Object.entries(notes)) setNote(doc, cursor, key, note);
  }
}

const { kick, snare, hiHatClosed, hiHatOpen, crash, ride, tomHigh, tomFloor } = DRUM_PIECES;
const p = (...ids: number[]): Notes => Object.fromEntries(ids.map((id) => [`p${id}`, {}]));

export interface DemoOptions {
  bars: number;
  /** How many parts of the band, from the first. */
  parts: number;
}

/**
 * A short band score. Bar 1 and 2 hold music in every part, bar 3 is half filled (it is
 * completed with rests on the page) and the rest is empty.
 */
export function seedDemo(doc: Y.Doc, { bars, parts }: DemoOptions): void {
  doc.transact(() => {
    createScore(doc, "Spike");
    const barIds = insertBars(doc, { after: null, count: bars });
    const [first, second, third] = barIds;
    BAND.slice(0, parts).forEach((part, index) => {
      const partId = addPart(doc, part);
      if (first === undefined || second === undefined || third === undefined) return;
      if (index === 0) {
        write(doc, partId, first, [
          [8, { s6: { fret: 0 } }],
          [8, { s5: { fret: 2 } }],
          [8, { s4: { fret: 2 } }],
          [8, { s3: { fret: 1 } }],
          [4, { s2: { fret: 0 }, s1: { fret: 0 } }],
          [4, {}],
        ]);
        write(doc, partId, second, [
          [4, { s5: { fret: 3 } }],
          [4, { s4: { fret: 12 }, s3: { fret: 12 } }],
          [2, { s1: { fret: 15 } }],
        ]);
        write(doc, partId, third, [[4, { s6: { fret: 3 } }]]);
      } else if (index === 1) {
        write(doc, partId, first, [
          [8, p(kick.id, hiHatClosed.id)],
          [8, p(hiHatClosed.id)],
          [8, p(snare.id, hiHatClosed.id)],
          [8, p(hiHatOpen.id)],
          [8, p(kick.id, ride.id)],
          [8, p(ride.id)],
          [8, p(snare.id, crash.id)],
          [8, p(tomHigh.id)],
        ]);
        write(doc, partId, second, [
          [4, p(kick.id, crash.id)],
          [4, p(snare.id)],
          [4, p(tomHigh.id)],
          [4, p(tomFloor.id)],
        ]);
        write(doc, partId, third, [[4, p(kick.id)]]);
      } else if (index === 2) {
        // The same pitch, 61, written once as C sharp and once as D flat; then 66 both ways.
        write(doc, partId, first, [
          [4, { n60: {} }],
          [4, { n61: { spell: "C#" } }],
          [4, { n61: { spell: "Db" } }],
          [4, { n64: {} }],
        ]);
        write(doc, partId, second, [
          [4, { n66: { spell: "F#" } }],
          [4, { n66: { spell: "Gb" } }],
          [2, { n67: {}, n72: {} }],
        ]);
        write(doc, partId, third, [[4, { n69: {} }]]);
      } else if (index === 3) {
        write(doc, partId, first, [
          [4, { s4: { fret: 0 } }],
          [4, { s4: { fret: 3 } }],
          [4, { s3: { fret: 2 } }],
          [4, { s3: { fret: 0 } }],
        ]);
      } else {
        write(doc, partId, first, [[1, { s6: { fret: 0 }, s5: { fret: 2 }, s4: { fret: 2 } }]]);
      }
    });
  }, LOCAL);
}

/** A repeatable stream of numbers, so that every run measures the same score. */
function sequence(seed: number): (below: number) => number {
  let state = seed;
  return (below) => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * below);
  };
}

/** The score the latency is measured on: every bar of every part of the band holds eight eighths. */
export function seedPerf(doc: Y.Doc, bars = 100): void {
  const next = sequence(20261112);
  const scale = [60, 62, 63, 65, 67, 68, 70, 72];
  const flats: Record<number, string> = { 63: "Eb", 68: "Ab", 70: "Bb" };
  doc.transact(() => {
    createScore(doc, `Perf ${bars} × ${BAND.length}`);
    const barIds = insertBars(doc, { after: null, count: bars });
    const [lead, drums, keys, bass, rhythm] = BAND.map((part) => addPart(doc, part)) as [string, string, string, string, string];
    for (const barId of barIds) {
      const root = next(8);
      const eighths = Array.from({ length: 8 }, (_, index) => index);
      write(doc, lead, barId, eighths.map(() => [8, { [`s${1 + next(4)}`]: { fret: 5 + next(12) } }]));
      write(doc, rhythm, barId, eighths.map(() => [8, { s6: { fret: root }, s5: { fret: root + 2 }, s4: { fret: root + 2 } }]));
      write(doc, bass, barId, eighths.map((index) => [8, { [`s${index % 4 === 3 ? 3 : 4}`]: { fret: root + (index % 4 === 3 ? 2 : 0) } }]));
      write(doc, drums, barId, eighths.map((index) => [8, p(hiHatClosed.id, ...(index % 4 === 0 ? [kick.id] : index % 4 === 2 ? [snare.id] : []))]));
      write(doc, keys, barId, eighths.map(() => {
        const pitch = scale[next(scale.length)] as number;
        const spell = flats[pitch];
        return [8, { [`n${pitch}`]: spell ? { spell } : {} }];
      }));
    }
  }, LOCAL);
}
