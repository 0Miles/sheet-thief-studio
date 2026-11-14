// What the recognizer answers (docs/spec/recognizer.md, section 5; docs/adr/0006): its own
// intermediate model, not the score's schema. It is described once for each side: the JSON Schema
// in services/recognizer/contract/recognition.schema.json holds the Python service to it, and
// these zod shapes are what the server reads it with. Both are tested on the same fixtures
// (services/recognizer/contract/fixtures/); a change of shape changes both and the version.
import { z } from "zod";

export const RECOGNIZER_CONTRACT = "sheet-thief-studio/recognition";

/** The version of the contract: one more whenever its shape changes. */
export const RECOGNIZER_CONTRACT_VERSION = 1;

/** The strings a recognized TAB may have. */
export const RECOGNIZER_STRINGS = { min: 4, max: 7 } as const;

/** The highest fret the recognizer reads (Guitar Pro 5's, in the predecessor's extract/common.py). */
export const RECOGNIZER_MAX_FRET = 29;

/** Written lengths in 32nd notes: each is one note value with no, one or two dots. */
export const RECOGNIZER_UNITS = [1, 2, 3, 4, 6, 7, 8, 12, 14, 16, 24, 28, 32, 48] as const;

const envelope = { contract: z.literal(RECOGNIZER_CONTRACT), version: z.literal(RECOGNIZER_CONTRACT_VERSION) };

const fret = z.int().min(0).max(RECOGNIZER_MAX_FRET);
const page = z.int().min(1);
const count = z.int().min(1);
const noParams = z.strictObject({});

const tuningMidi = z.array(z.int().min(0).max(127));

/** The tuning a part is written with, string 1 (the highest) first, and where it comes from. */
export const recognizerTuning = z.union([
  /** The tuning printed on the staff or in the heading. */
  z.strictObject({ midi: tuningMidi, source: z.literal("detected"), reason: z.null(), raw: z.null() }),
  /** None printed: the standard tuning for the strings. */
  z.strictObject({ midi: tuningMidi, source: z.literal("default"), reason: z.literal("not_found"), raw: z.null() }),
  /** One printed but not understood (docs/spec/recognizer.md, section 6): the standard tuning, and what was printed. */
  z.strictObject({ midi: tuningMidi, source: z.literal("default"), reason: z.literal("unrecognized"), raw: z.string().min(1) }),
]);
export type RecognizerTuning = z.infer<typeof recognizerTuning>;

/** The capo printed in the heading; when none is read, no capo. */
export const recognizerCapo = z.union([
  z.strictObject({ fret: z.int().min(0).max(24), source: z.literal("detected") }),
  z.strictObject({ fret: z.literal(0), source: z.literal("default") }),
]);
export type RecognizerCapo = z.infer<typeof recognizerCapo>;

export const recognizerTimeSignature = z.strictObject({
  numerator: z.int().min(1).max(16),
  denominator: z.literal([2, 4, 8, 16]),
});
export type RecognizerTimeSignature = z.infer<typeof recognizerTimeSignature>;

/** A note (the predecessor's ScoreNote), its marks already resolved: string 1 is the highest. */
export const recognizerNote = z
  .strictObject({
    string: z.int().min(1).max(RECOGNIZER_STRINGS.max),
    /** null for a dead note, and only for one. */
    fret: fret.nullable(),
    dead: z.boolean(),
    ghost: z.boolean(),
    tie: z.boolean(),
    vibrato: z.boolean(),
    /** Hammer-on or pull-off to the next note on the string. */
    hammer: z.boolean(),
    /** Legato slide to the next note on the string. */
    slide: z.boolean(),
    /** Shift slide: the next note on the string is picked again. */
    slideShift: z.boolean(),
    slideIn: z.enum(["below", "above"]).nullable(),
    slideOut: z.enum(["down", "up"]).nullable(),
    harmonic: z.enum(["natural", "pinch", "artificial"]).nullable(),
    tapped: z.boolean(),
    /** A grace note just before this one, on the same string. */
    graceFret: fret.nullable(),
    graceHammer: z.boolean(),
    staccato: z.boolean(),
    bendSemitones: z.int().min(0),
    bendRelease: z.boolean(),
    bendPre: z.boolean(),
    letRing: z.boolean(),
    palmMute: z.boolean(),
    /** "down" goes from the low strings to the high ones. */
    stroke: z.enum(["down", "up"]).nullable(),
    /** The MIDI velocity of the dynamic in force. */
    velocity: z.int().min(1).max(127).nullable(),
  })
  .refine((note) => note.dead === (note.fret === null), { path: ["fret"], message: "null exactly for a dead note" })
  .refine((note) => note.graceFret !== null || !note.graceHammer, { path: ["graceHammer"], message: "only with a grace note" });
export type RecognizerNote = z.infer<typeof recognizerNote>;

/** A beat (the predecessor's ScoreBeat): a rest when it has no notes. */
export const recognizerBeat = z.strictObject({
  /** The written length, in 32nd notes. */
  units: z.literal(RECOGNIZER_UNITS),
  /** A triplet: it sounds two thirds of its written length. */
  tuplet: z.boolean(),
  notes: z.array(recognizerNote).refine((notes) => new Set(notes.map((note) => note.string)).size === notes.length, "one note per string at most"),
});
export type RecognizerBeat = z.infer<typeof recognizerBeat>;

/** A bar (the predecessor's ScoreMeasure). Its beats may not fill or may overfill its time signature: they are kept as read. */
export const recognizerBar = z.strictObject({
  /** From this bar on; null keeps the one before (the song's for the first bar). */
  timeSignature: recognizerTimeSignature.nullable(),
  /** The name of the section starting here. */
  marker: z.string().min(1).nullable(),
  /** BPM from this bar on. */
  tempo: z.int().min(20).max(400).nullable(),
  repeatOpen: z.boolean(),
  /** A repeat ends with this bar, played this many times in all; 0 when none ends here. */
  repeatTimes: z.union([z.literal(0), z.int().min(2).max(32)]),
  /** The passes of a repeat this bar is played on (a volta), smallest first. */
  endings: z.array(z.int().min(1).max(9)).refine((passes) => new Set(passes).size === passes.length, "each pass once"),
  sign: z.enum(["segno", "coda", "fine"]).nullable(),
  /** Where to go after this bar. */
  jump: z.enum(["da_capo", "da_capo_al_coda", "da_capo_al_fine", "da_segno", "da_segno_al_coda", "da_segno_al_fine", "to_coda"]).nullable(),
  /** The durations were estimated from the spacing of the notes. */
  rhythmEstimated: z.boolean(),
  beats: z.array(recognizerBeat).min(1),
});
export type RecognizerBar = z.infer<typeof recognizerBar>;

/** A warning, or something recognition left out: a code and its parameters, never text. */
export const recognizerWarning = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("rhythm_estimated"), params: z.strictObject({ bars: z.array(page).min(1).refine((bars) => new Set(bars).size === bars.length, "each bar once") }) }),
  z.strictObject({ code: z.literal("overlapping_notes"), params: z.strictObject({ page, count }) }),
  z.strictObject({ code: z.literal("staves_ignored"), params: z.strictObject({ count }) }),
  z.strictObject({ code: z.literal("bar_too_dense"), params: z.strictObject({ page, notes: count }) }),
  z.strictObject({ code: z.literal("fixed_durations"), params: noParams }),
  /** A warning with no code yet: its text goes only to the log. */
  z.strictObject({ code: z.literal("other"), params: noParams }),
]);
export type RecognizerWarning = z.infer<typeof recognizerWarning>;

/** A recognized TAB: one part, as read, before anything is cut to fit the time signature. */
export const recognizerResult = z
  .strictObject({
    ...envelope,
    strings: z.int().min(RECOGNIZER_STRINGS.min).max(RECOGNIZER_STRINGS.max),
    tuning: recognizerTuning,
    capo: recognizerCapo,
    /** The first bar's. */
    timeSignature: recognizerTimeSignature,
    bars: z.array(recognizerBar).min(1),
    warnings: z.array(recognizerWarning),
  })
  .superRefine((result, context) => {
    if (result.tuning.midi.length !== result.strings) {
      context.addIssue({ code: "custom", path: ["tuning", "midi"], message: `one pitch for each of the ${result.strings} strings` });
    }
    result.bars.forEach((bar, b) =>
      bar.beats.forEach((beat, t) =>
        beat.notes.forEach((note, n) => {
          if (note.string > result.strings) {
            context.addIssue({ code: "custom", path: ["bars", b, "beats", t, "notes", n, "string"], message: `at most ${result.strings}` });
          }
        }),
      ),
    );
  });
export type RecognizerResult = z.infer<typeof recognizerResult>;

/** Why a page could not be read. */
export const recognizerPageError = z.strictObject({
  page,
  code: z.enum(["no_staff", "no_notes", "invalid_image", "image_too_large"]),
});
export type RecognizerPageError = z.infer<typeof recognizerPageError>;

/** A failed recognition: 422, or 503 for `busy`. Only `recognition_failed` lists pages. */
export const recognizerFailure = z.strictObject({
  ...envelope,
  error: z
    .strictObject({
      code: z.enum(["recognition_failed", "timeout", "unavailable", "busy"]),
      params: noParams,
      pages: z.array(recognizerPageError),
    })
    .refine((error) => error.code === "recognition_failed" || error.pages.length === 0, { path: ["pages"], message: "only for recognition_failed" }),
});
export type RecognizerFailure = z.infer<typeof recognizerFailure>;

/** Everything `POST /recognize` answers with a body of the contract. */
export const recognizerResponse = z.union([recognizerResult, recognizerFailure]);
export type RecognizerResponse = z.infer<typeof recognizerResponse>;
