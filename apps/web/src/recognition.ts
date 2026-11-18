// What the phrase library and the review page make of a recognition (docs/spec/phrases.md,
// sections 4 and 7; docs/spec/recognizer.md): the images sent as a form, what a refused upload
// says, the name a phrase saved from it starts with, why it failed, how its tuning was read, and
// the polling while it runs.
import type { RecognitionDetails, RecognitionError, RecognitionReport } from "@studio/contracts";

import { ApiError, refusal } from "./api";
import { strings } from "./strings";

const text = strings.recognition;

/** How often the review page asks how a running recognition is doing (docs/spec/phrases.md, section 7). */
export const POLL_INTERVAL_MS = 2000;

/** The images in the order they were chosen, each in the field `images` (docs/spec/routes.md, 3.8). */
export function uploadForm(files: readonly File[]): FormData {
  const form = new FormData();
  for (const file of files) form.append("images", file);
  return form;
}

/** What to say of an upload the server refused: which image is of the wrong type, sizes, how many. */
export function uploadRefusal(failure: unknown): string {
  if (!(failure instanceof ApiError)) return strings.unknownError;
  const page = failure.params?.page;
  if (failure.code === "unsupported_image" && typeof page === "number") return strings.phrases.unsupportedImage(page);
  if (failure.code === "payload_too_large") return strings.phrases.imagesTooLarge;
  if (failure.code === "invalid_request") {
    // The field `images`: none, or too many (docs/spec/routes.md, 3.8); no field named, a body
    // that could not be read as images.
    const issue = imagesIssueOf(failure.params);
    if (issue === "too_big") return strings.phrases.tooManyImages;
    if (issue === "too_small") return strings.phrases.noImages;
    return strings.phrases.uploadUnreadable;
  }
  return refusal(failure);
}

/** What a 400 says is wrong with the field `images`; null when it names no such field. */
function imagesIssueOf(params: Record<string, unknown> | null): string | null {
  const issues = params?.issues;
  if (!Array.isArray(issues)) return null;
  for (const issue of issues as unknown[]) {
    if (typeof issue !== "object" || issue === null) continue;
    const { path, code } = issue as { path?: unknown; code?: unknown };
    if (Array.isArray(path) && path.length === 1 && path[0] === "images" && typeof code === "string") return code;
  }
  return null;
}

/** 「辨識結果 YYYY-MM-DD」, the day it was recognized as the browser counts days. */
export function defaultRecognitionName(createdAt: string): string {
  const at = new Date(createdAt);
  const two = (value: number) => String(value).padStart(2, "0");
  return text.defaultName(`${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`);
}

export interface FailureText {
  reason: string;
  advice: string;
  /** Each page's own reason, when the recognizer gave some. */
  pages: string[];
}

export function failureOf(error: RecognitionError): FailureText {
  return { ...text.failures[error.code], pages: error.pages.map(({ page, code }) => text.pageFailure(page, code)) };
}

/** What to say of the tuning: a warning when one was printed but not understood, a note when none was; nothing when it was read. */
export function tuningNote({ tuning }: RecognitionReport): { warning: boolean; text: string } | null {
  if (tuning.source === "detected") return null;
  if (tuning.reason === "unrecognized") return { warning: true, text: text.tuningUnrecognized(tuning.raw) };
  return { warning: false, text: text.tuningNotFound };
}

/**
 * Ask at once, then every 2 seconds while the recognition runs; a failed ask is told and asked
 * again, except a 404 (it is gone). Returns what stops it.
 */
export function pollRecognition(read: () => Promise<RecognitionDetails>, onRead: (details: RecognitionDetails) => void, onFailure: (failure: unknown) => void): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ask = async () => {
    let again: boolean;
    try {
      const details = await read();
      if (stopped) return;
      onRead(details);
      again = details.status === "running";
    } catch (failure) {
      if (stopped) return;
      onFailure(failure);
      again = !(failure instanceof ApiError && failure.status === 404);
    }
    if (again && !stopped) timer = setTimeout(() => void ask(), POLL_INTERVAL_MS);
  };
  void ask();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
