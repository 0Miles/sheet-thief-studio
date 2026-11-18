// Calling the recognizer service (docs/spec/recognizer.md, section 3): `POST /recognize` on the
// internal network with the images as `multipart/form-data`, its answer read through the
// contract (packages/contracts/src/recognizer.ts). Whatever happens, the caller gets a result or
// a failure with a code: the details of what went wrong go to the log only.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

import { type RecognitionError, type RecognizerResult, recognizerFailure, recognizerResult } from "@studio/contracts";
import type { FastifyBaseLogger } from "fastify";

import { RECOGNIZER_ANSWER_LIMIT } from "./limits";

/**
 * How long the server waits for an answer: the recognizer gives up after 900 seconds in all, and
 * 30 more leave it time to say so (docs/spec/recognizer.md, section 3).
 */
export const RECOGNIZER_TIMEOUT_MS = 930_000;

/** An image to recognize: its bytes and their type, one of the three the server takes. */
export interface PageImage {
  mime: string;
  data: Buffer;
}

export type Recognized = { status: "succeeded"; result: RecognizerResult } | { status: "failed"; error: RecognitionError };

export function failure(code: RecognitionError["code"]): Recognized & { status: "failed" } {
  return { status: "failed", error: { code, params: {}, pages: [] } };
}

const EXTENSIONS: Readonly<Record<string, string>> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/** The images as `multipart/form-data`, each in a field `images`, in the order of their pages. */
async function formOf(images: readonly PageImage[]): Promise<{ type: string; body: Buffer }> {
  const form = new FormData();
  images.forEach(({ mime, data }, index) => form.append("images", new Blob([new Uint8Array(data)], { type: mime }), `page-${index + 1}.${EXTENSIONS[mime] ?? "bin"}`));
  const encoded = new Response(form);
  return { type: encoded.headers.get("content-type")!, body: Buffer.from(await encoded.arrayBuffer()) };
}

/** Send the request; resolves with the answer's status and body, at most `RECOGNIZER_ANSWER_LIMIT` bytes of it. */
function post(url: URL, form: { type: string; body: Buffer }, signal: AbortSignal): Promise<{ status: number; body: Buffer }> {
  // node:http rather than fetch: fetch gives up waiting for the headers of an answer after 300
  // seconds, and the recognizer may take 900.
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const request = send(url, { method: "POST", headers: { "content-type": form.type, "content-length": form.body.length }, signal }, (response: IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > RECOGNIZER_ANSWER_LIMIT) return request.destroy(new Error(`the recognizer answered more than ${RECOGNIZER_ANSWER_LIMIT} bytes`));
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end(form.body);
  });
}

/**
 * The answer's JSON. Read with the contract's strict objects, not score-model's `parsePlain`: its
 * depth is the score document's, and a note of the contract sits deeper. A key the contract does
 * not name, `__proto__` included, fails the strict objects.
 */
function readJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Recognize these images as the pages of one TAB. `stop` aborts the call when the server closes:
 * the recognition is then `interrupted`. The recognizer still busy is `busy`; an answer that is
 * not the contract's, or none, `unavailable`; no answer within 930 seconds `timeout`.
 */
export async function recognize(recognizerUrl: string, images: readonly PageImage[], stop: AbortSignal, log: FastifyBaseLogger): Promise<Recognized> {
  const timeout = AbortSignal.timeout(RECOGNIZER_TIMEOUT_MS);
  let answer: { status: number; body: Buffer };
  try {
    answer = await post(new URL("/recognize", recognizerUrl), await formOf(images), AbortSignal.any([stop, timeout]));
  } catch (error) {
    if (stop.aborted) return failure("interrupted");
    if (timeout.aborted) return failure("timeout");
    log.error({ error }, "calling the recognizer failed");
    return failure("unavailable");
  }
  if (answer.status === 503) return failure("busy");
  const body = readJson(answer.body);
  if (answer.status === 200) {
    const result = recognizerResult.safeParse(body);
    if (result.success) return { status: "succeeded", result: result.data };
    log.error({ issues: result.error.issues }, "the recognizer answered a result not of the contract");
  } else if (answer.status === 422) {
    const failed = recognizerFailure.safeParse(body);
    if (failed.success) return { status: "failed", error: failed.data.error };
    log.error({ issues: failed.error.issues }, "the recognizer answered a failure not of the contract");
  } else {
    log.error({ status: answer.status, body: answer.body.subarray(0, 1024).toString("utf8") }, "the recognizer answered an unexpected status");
  }
  return failure("unavailable");
}
