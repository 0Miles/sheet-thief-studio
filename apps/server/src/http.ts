// What every API route shares: the Origin check and the shape of errors, `{ code, params? }`
// (docs/spec/routes.md, section 3; docs/spec/security.md, section 2).
import type { FastifyInstance, FastifyReply } from "fastify";
import type { z } from "zod";

/** Refuse a request that may change something unless the browser says it comes from our own page. */
export function checkOrigin(app: FastifyInstance, publicOrigin: string): void {
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api/") || request.method === "GET" || request.method === "HEAD") return;
    if (request.headers.origin !== publicOrigin) return reply.code(403).send({ code: "bad_origin" });
  });
}

/** Errors Fastify raises itself (a body that is not JSON, an unknown API path) in the same shape. */
export function apiErrors(app: FastifyInstance): void {
  app.setErrorHandler((error: { statusCode?: number }, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status === 413) return reply.code(413).send({ code: "payload_too_large" });
    if (status >= 400 && status < 500) return reply.code(status).send({ code: "invalid_request" });
    request.log.error(error);
    return reply.code(500).send({ code: "internal_error" });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ code: "not_found" }));
}

export function invalidRequest(reply: FastifyReply, error: z.ZodError) {
  const issues = error.issues.map((issue) => ({ path: issue.path.map(String), code: issue.code }));
  return reply.code(400).send({ code: "invalid_request", params: { issues } });
}
