// Calls to the server's JSON API (docs/spec/routes.md, section 3), under where the page is served.
// The session cookie goes along by itself: the page and the API share one origin. Behind the
// karyl-chan bot, whose proxy drops cookies, the session goes as a Bearer token instead
// (docs/spec/karyl-login.md, section 5).
import { apiError, type CollabTicket, collabTicket, type ErrorCode, type GuestTicket, guestTicket } from "@studio/contracts";

import { appPath, appUrl, bearerToken, forgetBearer } from "./served";
import { errorText, strings } from "./strings";

/**
 * An answer other than 2xx, with the stable code the server sent (`internal_error` when none), how
 * long its `Retry-After` asks to wait, in milliseconds, when it says (a 429 does), and the
 * `params` of the code when it has some (a 415 names its image).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    readonly retryAfterMs: number | null = null,
    readonly params: Record<string, unknown> | null = null,
  ) {
    super(`${status} ${code}`);
  }
}

/** A `Retry-After` header in milliseconds from now: seconds, or a date; null when there is none or it cannot be read. */
function retryAfterOf(header: string | null, now = Date.now()): number | null {
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
  // A form goes as it is: the browser writes its multipart/form-data and the boundary.
  const form = body instanceof FormData;
  const headers: Record<string, string> = body === undefined || form ? {} : { "content-type": "application/json" };
  const bearer = bearerToken();
  if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
  const response = await fetch(appPath(path), {
    method,
    headers,
    body: body === undefined ? undefined : form ? body : JSON.stringify(body),
  });
  if (response.ok) return response;
  const error = apiError.safeParse(await response.json().catch(() => null));
  const { code, params } = error.success ? error.data : { code: "internal_error" as const, params: undefined };
  // The server no longer knows the session the token named: it is kept no longer.
  if (bearer !== null && code === "unauthenticated") forgetBearer();
  throw new ApiError(response.status, code, retryAfterOf(response.headers.get("retry-after")), params ?? null);
}

/**
 * GET a file the API answers with (a recognition's image), as an object URL for an `<img>`: an
 * image's own request would carry no Bearer token. The caller revokes it when done.
 */
export async function getObjectUrl(path: string): Promise<string> {
  return URL.createObjectURL(await (await call("GET", path)).blob());
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

/** POST, the answer checked against its shape in @studio/contracts; a FormData body goes as multipart/form-data. */
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

/** The WebSocket address of /collab on this server, under where the page is served (docs/adr/0001). */
export function collabUrl(): string {
  const url = new URL(appUrl("/collab"));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
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
