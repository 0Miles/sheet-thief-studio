// Calls to the server's JSON API (docs/spec/routes.md, section 3). The session cookie goes along
// by itself: the page and the API share one origin.
import { apiError, type CollabTicket, collabTicket, type ErrorCode, type GuestTicket, guestTicket } from "@studio/contracts";

import { errorText, strings } from "./strings";

/**
 * An answer other than 2xx, with the stable code the server sent (`internal_error` when none), and
 * how long its `Retry-After` asks to wait, in milliseconds, when it says (a 429 does).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly retryAfterMs: number | null = null,
  ) {
    super(`${status} ${code}`);
  }
}

/** A `Retry-After` header in milliseconds from now: seconds, or a date; null when there is none or it cannot be read. */
export function retryAfterOf(header: string | null, now = Date.now()): number | null {
  if (header === null || header.trim() === "") return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** What to tell the person about a call that failed: the text of the code the server answered with, when it answered. */
export function refusal(failure: unknown): string {
  return failure instanceof ApiError ? errorText(failure.code) : strings.unknownError;
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.ok) return response;
  const error = apiError.safeParse(await response.json().catch(() => null));
  throw new ApiError(response.status, error.success ? error.data.code : "internal_error", retryAfterOf(response.headers.get("retry-after")));
}

/** GET, the answer checked against its shape in @studio/contracts. */
export async function get<T>(path: string, shape: { parse(value: unknown): T }): Promise<T> {
  return shape.parse(await (await call("GET", path)).json());
}

/** POST without an answer to read (204). */
export async function post(path: string, body?: unknown): Promise<void> {
  await call("POST", path, body);
}

/** DELETE, without an answer to read (204). */
export async function del(path: string): Promise<void> {
  await call("DELETE", path);
}

/** POST, the answer checked against its shape in @studio/contracts. */
export async function postFor<T>(path: string, body: unknown, shape: { parse(value: unknown): T }): Promise<T> {
  return shape.parse(await (await call("POST", path, body)).json());
}

/** PUT, the answer checked against its shape in @studio/contracts. */
export async function putFor<T>(path: string, body: unknown, shape: { parse(value: unknown): T }): Promise<T> {
  return shape.parse(await (await call("PUT", path, body)).json());
}

/** PATCH, the answer checked against its shape in @studio/contracts. */
export async function patchFor<T>(path: string, body: unknown, shape: { parse(value: unknown): T }): Promise<T> {
  return shape.parse(await (await call("PATCH", path, body)).json());
}

/** The WebSocket address of /collab on this server (docs/adr/0001). */
export function collabUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collab`;
}

/**
 * A new collab ticket for the score, with the member's role as it is now. A provider's `token`
 * calls it for every connection, reconnections included (ADR 0005).
 */
export function newCollabTicket(scoreId: string): Promise<CollabTicket> {
  return postFor(`/api/scores/${scoreId}/collab-ticket`, undefined, collabTicket);
}

/** What a read-only link opens, with a new collab ticket: no session needed (docs/spec/collab.md, section 3). */
export function guestTicketFor(token: string): Promise<GuestTicket> {
  return postFor(`/api/s/${encodeURIComponent(token)}`, undefined, guestTicket);
}
