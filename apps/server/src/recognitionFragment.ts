// The recognizer's intermediate model made a fragment of bars of a fretted part (docs/spec/
// recognizer.md, 7.2), and the report of what was read beside it and what it leaves out. Only
// marks, never rewrites: a bar that overfills its time signature stays as it was read.
import type { RecognitionReport, RecognitionSkipped, RecognizerBar, RecognizerBeat, RecognizerNote, RecognizerResult } from "@studio/contracts";
import { BEND_SEMITONES, type BarsFragment, type BeatWithoutId, type BendType, DYNAMICS, type NoteJSON, type NoteValue, type TimeSignature, tuningFor } from "@studio/score-model";

type FrettedFragment = Extract<BarsFragment, { kind: "fretted" }>;
type Dynamic = (typeof DYNAMICS)[number];

/** The only voice of the only staff of a TAB. */
const VOICE = "0:0";

/** A written length in 32nd notes as a note value and its dots: the lengths the contract allows. */
const DURATIONS: Readonly<Record<RecognizerBeat["units"], { value: NoteValue; dots: 0 | 1 | 2 }>> = {
  1: { value: 32, dots: 0 },
  2: { value: 16, dots: 0 },
  3: { value: 16, dots: 1 },
  4: { value: 8, dots: 0 },
  6: { value: 8, dots: 1 },
  7: { value: 8, dots: 2 },
  8: { value: 4, dots: 0 },
  12: { value: 4, dots: 1 },
  14: { value: 4, dots: 2 },
  16: { value: 2, dots: 0 },
  24: { value: 2, dots: 1 },
  28: { value: 2, dots: 2 },
  32: { value: 1, dots: 0 },
  48: { value: 1, dots: 1 },
};

/**
 * The dynamic nearest a MIDI velocity (the predecessor's app/extract/annotations.py:35): ppp
 * counts as pp and fff as ff, the softest and loudest a beat can have.
 */
function dynamicOf(velocity: number): Dynamic {
  if (velocity <= 39) return "pp";
  if (velocity <= 55) return "p";
  if (velocity <= 71) return "mp";
  if (velocity <= 87) return "mf";
  if (velocity <= 103) return "f";
  return "ff";
}

/**
 * What the notes of a beat have in common, for a mark of the beat: the value most of them have,
 * on a tie the value of the note on the lowest numbered string; the notes with none do not count.
 * Undefined when none has one.
 */
function sharedValue<Value>(notes: readonly RecognizerNote[], valueOf: (note: RecognizerNote) => Value | null): Value | undefined {
  const counts = new Map<Value, { count: number; lowestString: number }>();
  for (const note of notes) {
    const value = valueOf(note);
    if (value === null) continue;
    const seen = counts.get(value);
    counts.set(value, seen === undefined ? { count: 1, lowestString: note.string } : { count: seen.count + 1, lowestString: Math.min(seen.lowestString, note.string) });
  }
  let best: [Value, { count: number; lowestString: number }] | undefined;
  for (const entry of counts) {
    if (best === undefined || entry[1].count > best[1].count || (entry[1].count === best[1].count && entry[1].lowestString < best[1].lowestString)) best = entry;
  }
  return best?.[0];
}

function bendType(note: RecognizerNote): BendType {
  if (note.bendPre) return note.bendRelease ? "preBendRelease" : "preBend";
  return note.bendRelease ? "bendRelease" : "bend";
}

/** What reading the notes found to leave out. */
interface Tally {
  graceNotes: number;
  bendsClamped: number;
}

function noteOf(note: RecognizerNote, tally: Tally): NoteJSON {
  const made: NoteJSON = {};
  if (note.dead) made.dead = true;
  else if (note.fret !== null) made.fret = note.fret;
  if (note.ghost) made.ghost = true;
  if (note.tie) made.tie = true;
  if (note.vibrato) made.vibrato = true;
  if (note.staccato) made.staccato = true;
  if (note.letRing) made.letRing = true;
  if (note.palmMute) made.palmMute = true;
  if (note.tapped) made.tap = true;
  if (note.harmonic !== null) made.harmonic = note.harmonic;
  if (note.hammer) made.legato = true;
  // A slide on to the next note wins over one out of the note into nothing; a shift slide over a legato one.
  if (note.slideShift) made.slideOut = "shift";
  else if (note.slide) made.slideOut = "legato";
  else if (note.slideOut !== null) made.slideOut = note.slideOut === "up" ? "outUp" : "outDown";
  if (note.slideIn !== null) made.slideIn = note.slideIn === "below" ? "inBelow" : "inAbove";
  if (note.bendSemitones > 0) {
    if (note.bendSemitones > BEND_SEMITONES.max) tally.bendsClamped += 1;
    made.bend = { type: bendType(note), semitones: Math.min(note.bendSemitones, BEND_SEMITONES.max) };
  }
  // Grace notes are left out (the predecessor's app/model.py:51-53), and counted.
  if (note.graceFret !== null) tally.graceNotes += 1;
  return made;
}

/** The marks of the bars a phrase carries none of, each reported once. */
function barMarksOf(bars: readonly RecognizerBar[]): RecognitionSkipped[] {
  const skipped: RecognitionSkipped[] = [];
  if (bars.some((bar) => bar.marker !== null)) skipped.push({ code: "sections" });
  if (bars.some((bar) => bar.tempo !== null)) skipped.push({ code: "tempo" });
  if (bars.some((bar) => bar.repeatOpen || bar.repeatTimes > 0 || bar.endings.length > 0)) skipped.push({ code: "repeats" });
  if (bars.some((bar) => bar.sign !== null || bar.jump !== null)) skipped.push({ code: "jumps" });
  return skipped;
}

/** A recognized TAB as a fragment of bars of a fretted part, with its report. Check the fragment with `barsFragmentSchema` before keeping it. */
export function fragmentOfRecognition(result: RecognizerResult): { fragment: FrettedFragment; report: RecognitionReport } {
  const tally: Tally = { graceNotes: 0, bendsClamped: 0 };
  let timeSig: TimeSignature = result.timeSignature;
  const bars = result.bars.map((bar) => {
    timeSig = bar.timeSignature ?? timeSig;
    const beats = bar.beats.map((beat): BeatWithoutId => {
      const made: BeatWithoutId = { ...DURATIONS[beat.units], notes: {} };
      if (beat.tuplet) made.tuplet = { actual: 3, normal: 2 };
      const stroke = sharedValue(beat.notes, (note) => note.stroke);
      if (stroke !== undefined) made.stroke = stroke;
      const dynamic = sharedValue(beat.notes, (note) => (note.velocity === null ? null : dynamicOf(note.velocity)));
      if (dynamic !== undefined) made.dynamic = dynamic;
      for (const note of beat.notes) made.notes[`s${note.string}`] = noteOf(note, tally);
      return made;
    });
    return { timeSig: { ...timeSig }, voices: { [VOICE]: beats } };
  });

  const skipped: RecognitionSkipped[] = [];
  if (tally.graceNotes > 0) skipped.push({ code: "grace_notes", count: tally.graceNotes });
  if (result.capo.fret !== 0) skipped.push({ code: "capo", fret: result.capo.fret });
  if (result.tuning.reason === "unrecognized") skipped.push({ code: "tuning_unrecognized", raw: result.tuning.raw });
  if (tally.bendsClamped > 0) skipped.push({ code: "bend_clamped", count: tally.bendsClamped });
  skipped.push(...barMarksOf(result.bars));

  // With none read, or none understood, the standard tuning of its strings, whatever the recognizer guessed.
  const tuning = result.tuning.source === "detected" ? [...result.tuning.midi] : tuningFor("standard", result.strings);
  return {
    fragment: { kind: "fretted", tuning, bars },
    report: { strings: result.strings, tuning: result.tuning, capo: result.capo, warnings: result.warnings, skipped },
  };
}
