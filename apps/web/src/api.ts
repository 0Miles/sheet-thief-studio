// Calls to the server's JSON API (docs/spec/routes.md, section 3). The session cookie goes along
// by itself: the page and the API share one origin.
import { apiError } from "@studio/contracts";

/** An answer other than 2xx, with the stable code the server sent (`internal_error` when none). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfterSeconds: number | null = null,
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
  const retryAfter = response.headers.get("retry-after");
  throw new ApiError(response.status, error.success ? error.data.code : "internal_error", retryAfter === null ? null : Number(retryAfter));
}

/** GET, the answer checked against its shape in @studio/contracts. */
export async function get<T>(path: string, shape: { parse(value: unknown): T }): Promise<T> {
  return shape.parse(await (await call("GET", path)).json());
}

/** POST without an answer to read (204). */
export async function post(path: string, body?: unknown): Promise<void> {
  await call("POST", path, body);
}
