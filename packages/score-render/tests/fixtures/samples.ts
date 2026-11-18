// The scores of the round-trip test (docs/spec/import-export.md, section 4), as plain data. Ids are
// left out where a test compares scores (`withoutIds` in importExport.test.ts): an import makes new ones.
import type { ScoreJSON } from "@studio/score-model";

const COMMON = { numerator: 4, denominator: 4 } as const;
const WALTZ = { numerator: 3, denominator: 4 } as const;

/**
 * The score round-trip.gp is exported from: the three kinds of part, the techniques of each, a
 * repeat with voltas, a section, changes of tempo, key and time, and lyrics with a melisma. Every
 * pitched note is spelled, as the editor writes it (docs/spec/schema.md, 8.1).
 */
export const GP7_SAMPLE: ScoreJSON = {
  schemaVersion: 1,
  title: "Round Trip GP7",
  artist: "Studio Band",
  bars: [
    { id: "b1", timeSig: COMMON, tempo: 96, keySig: { fifths: 2, mode: "major" }, section: "Intro", repeatStart: true },
    { id: "b2", timeSig: COMMON, voltas: [1], repeatEnd: 2 },
    { id: "b3", timeSig: WALTZ, voltas: [2], tempo: 140, keySig: { fifths: -3, mode: "minor" } },
  ],
  parts: [
    {
      id: "guitar",
      name: "Guitar",
      kind: "fretted",
      tuning: [64, 59, 55, 50, 45, 40],
      capo: 2,
      program: 27,
      staves: [{ clef: "tab" }],
      content: {
        b1: {
          "0:0": [
            { id: "g1", value: 4, dots: 0, dynamic: "mp", text: "Am", notes: { s1: { fret: 5, legato: true } } },
            { id: "g2", value: 4, dots: 0, stroke: "down", notes: { s1: { fret: 7, slideOut: "shift" } } },
            { id: "g3", value: 8, dots: 1, notes: { s1: { fret: 9, bend: { type: "bendRelease", semitones: 2 }, vibrato: true } } },
            { id: "g4", value: 16, dots: 0, slap: true, notes: { s2: { fret: 12, harmonic: "natural" }, s3: { dead: true } } },
            { id: "g5", value: 8, dots: 0, tuplet: { actual: 3, normal: 2 }, notes: { s6: { fret: 0, palmMute: true, accent: true } } },
            { id: "g6", value: 8, dots: 0, tuplet: { actual: 3, normal: 2 }, notes: { s6: { fret: 0, letRing: true, staccato: true, ghost: true } } },
            { id: "g7", value: 8, dots: 0, tuplet: { actual: 3, normal: 2 }, pop: true, notes: { s5: { fret: 2, tap: true, slideIn: "inBelow", harmonic: "pinch" } } },
          ],
        },
        b2: { "0:0": [{ id: "g8", value: 1, dots: 0, notes: { s5: { fret: 2, tie: true, bend: { type: "preBend", semitones: 1 } } } }] },
        b3: { "0:0": [{ id: "g9", value: 2, dots: 1, stroke: "up", dynamic: "ff", notes: { s4: { fret: 3, harmonic: "artificial", slideOut: "outDown" } } }] },
      },
    },
    {
      id: "drums",
      name: "Drums",
      kind: "percussion",
      tuning: [],
      capo: 0,
      program: 0,
      staves: [{ clef: "neutral" }],
      content: {
        b1: {
          "0:0": [
            { id: "d1", value: 2, dots: 0, notes: { p42: {}, p38: { ghost: true } } },
            { id: "d2", value: 2, dots: 0, notes: { p92: { accent: true }, p91: {} } },
          ],
          "0:1": [{ id: "d3", value: 1, dots: 0, notes: { p36: {} } }],
        },
        b2: { "0:0": [{ id: "d4", value: 1, dots: 0, notes: { p49: {}, p36: {} } }] },
        b3: { "0:0": [] },
      },
    },
    {
      id: "keys",
      name: "Keys",
      kind: "pitched",
      tuning: [],
      capo: 0,
      program: 0,
      staves: [{ clef: "treble" }, { clef: "bass" }],
      content: {
        b1: {
          "0:0": [
            { id: "k1", value: 4, dots: 0, lyric: "Hel-", notes: { n61: { spell: "Db" }, n64: { spell: "E" } } },
            { id: "k2", value: 4, dots: 0, lyric: "lo", notes: { n60: { spell: "C", staccato: true } } },
            { id: "k3", value: 4, dots: 0, lyric: "", notes: { n66: { spell: "F#", accent: true } } },
            { id: "k4", value: 4, dots: 0, notes: { n66: { spell: "F#", tie: true } } },
          ],
          "1:0": [{ id: "k5", value: 1, dots: 0, notes: { n48: { spell: "C" } } }],
        },
        b2: { "0:0": [{ id: "k6", value: 1, dots: 0, lyric: "world", notes: { n62: { spell: "D" } } }], "1:0": [] },
        b3: {
          "0:0": [
            { id: "k7", value: 4, dots: 0, notes: { n63: { spell: "Eb" } } },
            { id: "k8", value: 4, dots: 0, notes: {} },
            { id: "k9", value: 4, dots: 0, notes: { n70: { spell: "A#" } } },
          ],
          "1:0": [],
          "1:1": [{ id: "k10", value: 2, dots: 1, notes: { n36: { spell: "C" } } }],
        },
      },
    },
  ],
};
