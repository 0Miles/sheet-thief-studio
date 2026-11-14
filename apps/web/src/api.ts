// Calls to the server's JSON API (docs/spec/routes.md, section 3). The session cookie goes along
// by itself: the page and the API share one origin.
import { apiError, collabTicket, type ErrorCode, type GuestTicket, guestTicket } from "@studio/contracts";

/** An answer other than 2xx, with the stable code the server sent (`internal_error` when none). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
  ) {
    super(`${status} ${code}`);
  }
}

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.ok) return response;
  const error = apiError.safeParse(await response.json().catch(() => null));
  throw new ApiError(response.status, error.success ? error.data.code : "internal_error");
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

/** PATCH, the answer checked against its shape in @studio/contracts. */
export async function patchFor<T>(path: string, body: unknown, shape: { parse(value: unknown): T }): Promise<T> {
  return shape.parse(await (await call("PATCH", path, body)).json());
}

/** The WebSocket address of /collab on this server (docs/adr/0001). */
export function collabUrl(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collab`;
}

/** A new collab ticket for the score. A provider's `token` calls it for every connection, reconnections included (ADR 0005). */
export async function newCollabTicket(scoreId: string): Promise<string> {
  return (await postFor(`/api/scores/${scoreId}/collab-ticket`, undefined, collabTicket)).ticket;
}

/** What a read-only link opens, with a new collab ticket: no session needed (docs/spec/collab.md, section 3). */
export function guestTicketFor(token: string): Promise<GuestTicket> {
  return postFor(`/api/s/${encodeURIComponent(token)}`, undefined, guestTicket);
}
