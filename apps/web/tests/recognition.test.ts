// What the review page and the library make of a recognition (docs/spec/phrases.md, sections 4 and
// 7; docs/spec/recognizer.md): the form the images go in, what a refused upload says, the name a
// saved phrase starts with, why a recognition failed, the tuning note, and the polling every 2 seconds.
import type { RecognitionDetails, RecognitionReport } from "@studio/contracts";
import { afterEach, expect, test, vi } from "vitest";

import { ApiError } from "../src/api";
import { defaultRecognitionName, failureOf, pollRecognition, POLL_INTERVAL_MS, tuningNote, uploadForm, uploadRefusal } from "../src/recognition";
import { strings } from "../src/strings";

const text = strings.recognition;

afterEach(() => {
  vi.useRealTimers();
});

test("the images go in the field images, in the order they were chosen", () => {
  const files = [new File(["a"], "1.png", { type: "image/png" }), new File(["b"], "2.jpg", { type: "image/jpeg" })];
  const form = uploadForm(files);
  expect(form.getAll("images").map((file) => (file as File).name)).toEqual(["1.png", "2.jpg"]);
  expect([...form.keys()]).toEqual(["images", "images"]);
});

test("a refused upload says which image is not of the three types, that the files are too large, or what its code says", () => {
  expect(uploadRefusal(new ApiError(415, "unsupported_image", null, { page: 2 }))).toBe(strings.phrases.unsupportedImage(2));
  expect(uploadRefusal(new ApiError(415, "unsupported_image"))).toBe(strings.errors.unsupported_image);
  expect(uploadRefusal(new ApiError(413, "payload_too_large"))).toBe(strings.phrases.imagesTooLarge);
  expect(uploadRefusal(new ApiError(400, "invalid_request"))).toBe(strings.phrases.tooManyImages);
  expect(uploadRefusal(new ApiError(409, "recognition_in_progress"))).toBe(strings.errors.recognition_in_progress);
  expect(uploadRefusal(new ApiError(503, "recognizer_busy"))).toBe(strings.errors.recognizer_busy);
  expect(uploadRefusal(new TypeError("Failed to fetch"))).toBe(strings.unknownError);
});

test("a phrase saved from a recognition is named after the day it was recognized, in the browser's time zone", () => {
  const at = new Date(2026, 10, 3, 23, 59);
  expect(defaultRecognitionName(at.toISOString())).toBe(text.defaultName("2026-11-03"));
});

test("a failure says why and what to try, and the reason of each page", () => {
  expect(failureOf({ code: "timeout", params: {}, pages: [] })).toEqual({ ...text.failures.timeout, pages: [] });
  expect(
    failureOf({
      code: "recognition_failed",
      params: {},
      pages: [
        { page: 1, code: "no_staff" },
        { page: 3, code: "image_too_large" },
      ],
    }),
  ).toEqual({ ...text.failures.recognition_failed, pages: [text.pageFailure(1, "no_staff"), text.pageFailure(3, "image_too_large")] });
});

const report = (tuning: RecognitionReport["tuning"]): RecognitionReport => ({ strings: 6, tuning, capo: { fret: 0, source: "default" }, warnings: [], skipped: [] });
const midi = [64, 59, 55, 50, 45, 40];

test("a tuning not understood is a warning with what was printed; none printed is a note; one read, nothing", () => {
  expect(tuningNote(report({ midi, source: "default", reason: "unrecognized", raw: "Standard, down 1/2 step" }))).toEqual({
    warning: true,
    text: text.tuningUnrecognized("Standard, down 1/2 step"),
  });
  expect(tuningNote(report({ midi, source: "default", reason: "not_found", raw: null }))).toEqual({ warning: false, text: text.tuningNotFound });
  expect(tuningNote(report({ midi, source: "detected", reason: null, raw: null }))).toBeNull();
});

const fields = { id: "r", pages: 1, createdAt: "2026-11-18T00:00:00.000Z" };

test("polling asks every 2 seconds while the recognition runs, and stops when it has finished", async () => {
  vi.useFakeTimers();
  const answers: RecognitionDetails[] = [
    { ...fields, status: "running" },
    { ...fields, status: "running" },
    { ...fields, status: "failed", error: { code: "busy", params: {}, pages: [] } },
  ];
  const read = vi.fn(async () => answers.shift()!);
  const seen: string[] = [];
  pollRecognition(read, (details) => seen.push(details.status), () => undefined);
  await vi.advanceTimersByTimeAsync(0);
  expect(seen).toEqual(["running"]);
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(seen).toEqual(["running", "running"]);
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  expect(seen).toEqual(["running", "running", "failed"]);
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 5);
  expect(read).toHaveBeenCalledTimes(3);
});

test("a failed ask is told and asked again 2 seconds later, unless it was a 404; stopping stops it", async () => {
  vi.useFakeTimers();
  const read = vi.fn<() => Promise<RecognitionDetails>>().mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValue({ ...fields, status: "running" });
  const failures: unknown[] = [];
  const stop = pollRecognition(read, () => undefined, (failure) => failures.push(failure));
  await vi.advanceTimersByTimeAsync(0);
  expect(failures).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
  expect(read).toHaveBeenCalledTimes(2);
  stop();
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
  expect(read).toHaveBeenCalledTimes(2);

  const gone = vi.fn<() => Promise<RecognitionDetails>>().mockRejectedValue(new ApiError(404, "not_found"));
  pollRecognition(gone, () => undefined, () => undefined);
  await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
  expect(gone).toHaveBeenCalledTimes(1);
});
