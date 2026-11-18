// Recognitions (docs/spec/routes.md, 3.8; docs/spec/recognizer.md, section 7): what the server
// keeps of the images an account sent to the recognizer, and what the API answers about them.
// The recognizer's own answers are in ./recognizer.ts; these are the server's.
import { barsFragmentSchema } from "@studio/score-model";
import { z } from "zod";

import { recognizerCapo, recognizerLimits, recognizerPageError, recognizerTuning, recognizerWarning } from "./recognizer";

/**
 * How many images one recognition reads, as pages in order, and how large each and all of them
 * may be, in bytes (docs/spec/recognizer.md, section 4).
 */
export const recognitionLimits = { images: { min: 1, max: 15 }, imageBytes: 10 * 1024 * 1024, imagesBytes: 40 * 1024 * 1024 } as const;

/** How long the server keeps a recognition, its images and its result (docs/spec/recognizer.md, section 7). */
export const RECOGNITION_RETENTION_DAYS = 7;

export const recognitionStatus = z.enum(["running", "succeeded", "failed"]);
export type RecognitionStatus = z.infer<typeof recognitionStatus>;

/**
 * Why a recognition failed: the recognizer's codes (docs/spec/recognizer.md, 5.2), and
 * `interrupted`, a recognition still running when the server stopped.
 */
export const recognitionError = z.strictObject({
  code: z.enum(["recognition_failed", "timeout", "unavailable", "busy", "interrupted"]),
  params: z.strictObject({}),
  pages: z.array(recognizerPageError),
});
export type RecognitionError = z.infer<typeof recognitionError>;

const count = z.int().min(1);

/** Something the fragment leaves out of what was read (docs/spec/recognizer.md, 7.2): the review page tells each by its code. */
export const recognitionSkipped = z.discriminatedUnion("code", [
  /** Grace notes, so many. */
  z.strictObject({ code: z.literal("grace_notes"), count }),
  /** The capo read, when not 0: a phrase has none. */
  z.strictObject({ code: z.literal("capo"), fret: z.int().min(1) }),
  /** A tuning printed but not understood: the fragment has the standard one of its strings. */
  z.strictObject({ code: z.literal("tuning_unrecognized"), raw: z.string().min(1) }),
  /** Bends of more than 4 semitones, so many, made 4. */
  z.strictObject({ code: z.literal("bend_clamped"), count }),
  /** Section names, tempos, repeats and voltas, signs and jumps: a phrase carries none of them. */
  z.strictObject({ code: z.literal("sections") }),
  z.strictObject({ code: z.literal("tempo") }),
  z.strictObject({ code: z.literal("repeats") }),
  z.strictObject({ code: z.literal("jumps") }),
]);
export type RecognitionSkipped = z.infer<typeof recognitionSkipped>;

/** What was read beside the fragment: the strings, tuning and capo as the recognizer read them, its warnings, and what the fragment leaves out. */
export const recognitionReport = z.strictObject({
  strings: z.int().min(recognizerLimits.strings.min).max(recognizerLimits.strings.max),
  tuning: recognizerTuning,
  capo: recognizerCapo,
  warnings: z.array(recognizerWarning),
  skipped: z.array(recognitionSkipped),
});
export type RecognitionReport = z.infer<typeof recognitionReport>;

/** What every recognition says of itself; its pages are its images, from 1. */
const recognitionFields = {
  id: z.string(),
  pages: z.int().min(recognitionLimits.images.min).max(recognitionLimits.images.max),
  createdAt: z.string(),
};

/** A recognition, as the review page polls it (`GET /api/recognitions/:id`). */
export const recognitionDetails = z.discriminatedUnion("status", [
  z.object({ ...recognitionFields, status: z.literal("running") }),
  z.object({ ...recognitionFields, status: z.literal("succeeded"), fragment: barsFragmentSchema, report: recognitionReport }),
  z.object({ ...recognitionFields, status: z.literal("failed"), error: recognitionError }),
]);
export type RecognitionDetails = z.infer<typeof recognitionDetails>;

/** My recognitions not yet saved nor discarded (`GET /api/recognitions`), the latest first. */
export const recognitionList = z.object({ recognitions: z.array(z.object({ ...recognitionFields, status: recognitionStatus })) });
export type RecognitionList = z.infer<typeof recognitionList>;

/** A recognition just started (`POST /api/recognitions`, 202). */
export const createdRecognition = z.object({ id: z.string() });
export type CreatedRecognition = z.infer<typeof createdRecognition>;
