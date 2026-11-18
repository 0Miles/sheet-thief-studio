// What every API route shares: the Origin check and the shape of errors, `{ code, params? }`
// (docs/spec/routes.md, section 3; docs/spec/security.md, section 2).
import type { FastifyInstance, FastifyReply } from "fastify";
import type { z } from "zod";

/**
 * Refuse a request that may change something unless the browser says it comes from our own page.
 * Every path, not only /api/: the router decodes a path before matching it, so a test on the raw
 * URL would let `/%61pi/…` through.
 */
export function registerOriginCheck(app: FastifyInstance, publicOrigin: string): void {
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "GET" || request.method === "HEAD") return;
    // The karyl-chan bot's dispatches: no browser sends them, and the plugin's HMAC key signs them.
    if (request.routeOptions.config.botDispatch) return;
    if (request.headers.origin !== publicOrigin) return reply.code(403).send({ code: "bad_origin" });
  });
}

/** Errors Fastify raises itself (a body that is not JSON, an unknown API path) in the same shape. */
export function registerErrorAnswers(app: FastifyInstance): void {
  app.setErrorHandler((error: { statusCode?: number }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status === 413) return reply.code(413).send({ code: "payload_too_large" });
    if (status >= 400 && status < 500) return reply.code(status).send({ code: "invalid_request" });
    request.log.error(error);
    return reply.code(500).send({ code: "internal_error" });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ code: "not_found" }));
}

/** Over a rate limit (docs/spec/security.md, section 4). */
export function rateLimited(reply: FastifyReply, retryAfterSeconds: number) {
  return reply.code(429).header("retry-after", String(retryAfterSeconds)).send({ code: "rate_limited" });
}

/** One field a request got wrong: where it is in the body, and what is wrong with it (a zod issue code). */
export interface FieldIssue {
  path: string[];
  code: string;
}

/**
 * 400 `invalid_request` naming the fields at fault: those zod refused, or those that do not fit
 * what the server already has (docs/spec/routes.md, section 4).
 */
export function invalidFields(reply: FastifyReply, issues: FieldIssue[]) {
  return reply.code(400).send({ code: "invalid_request", params: { issues } });
}

export function invalidRequest(reply: FastifyReply, error: z.ZodError) {
  return invalidFields(
    reply,
    error.issues.map((issue) => ({ path: issue.path.map(String), code: issue.code })),
  );
}

/**
 * Not a member, no such score and a deleted score all look the same; so do someone else's phrase
 * and none (docs/spec/security.md, 8).
 */
export function notFound(reply: FastifyReply) {
  return reply.code(404).send({ code: "not_found" });
}

/** Ids of scores and phrases are UUIDs: anything else names none, without asking Postgres. */
export function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}
