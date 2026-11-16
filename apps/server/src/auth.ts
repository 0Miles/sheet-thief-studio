// Logging in and out, and the session behind every other API call (docs/spec/routes.md, 3.1;
// docs/spec/security.md, sections 1 and 4).
import { loginRequest } from "@studio/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { checkCredentials, normalizeUsername } from "./accounts";
import type { CookieSettings } from "./config";
import { Account } from "./db/models";
import { invalidRequest, rateLimited } from "./http";
import { LOGIN_BY_IP, LOGIN_BY_USERNAME, type RateLimiter } from "./rateLimit";
import { SESSION_TTL_SECONDS, type Session, type Sessions } from "./sessions";

declare module "fastify" {
  interface FastifyInstance {
    sessions: Sessions;
  }
  interface FastifyContextConfig {
    /** Open without a session. Every other /api/ route answers 401 to a request without one. */
    public?: boolean;
    /**
     * Open to a session that must change its password first: changing it, logging out, and
     * reading whose session it is. Every other /api/ route answers it 403.
     */
    beforePasswordChange?: boolean;
  }
  interface FastifyRequest {
    /** The session and its account, on every /api/ route not marked public. */
    session: Session | null;
    account: Account | null;
  }
}

/**
 * Whether the request's session must change its password before anything else: the account has a
 * temporary one, and the session logged in with it. A session that logged in another way never
 * typed it (docs/spec/accounts.md, section 1).
 */
export function mustChangePassword(request: FastifyRequest): boolean {
  return request.account?.mustChangePassword === true && request.session?.via === "password";
}

export function registerAuth(app: FastifyInstance, { cookie, sessions, limiter }: { cookie: CookieSettings; sessions: Sessions; limiter: RateLimiter }): void {
  const cookieOptions = { path: "/", httpOnly: true, secure: cookie.secure, sameSite: "lax" } as const;
  // Sent again with every use, so the browser keeps the cookie as long as Redis keeps the session.
  const keepSession = (reply: FastifyReply, id: string) => reply.setCookie(cookie.name, id, { ...cookieOptions, maxAge: SESSION_TTL_SECONDS });

  app.decorate("sessions", sessions);
  app.decorateRequest("session", null);
  app.decorateRequest("account", null);
  // Every /api/ route needs a session unless it says otherwise, so a new route cannot be left
  // open by forgetting to ask for one. Unknown paths have no route and answer 404.
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.routeOptions.url?.startsWith("/api/") || request.routeOptions.config.public) return;
    const id = request.cookies[cookie.name];
    const session = id ? await sessions.resume(id) : null;
    const account = session ? await Account.findByPk(session.accountId) : null;
    if (!session || !account || account.disabledAt !== null) {
      if (session) await sessions.end({ sessionId: session.id });
      if (id) reply.clearCookie(cookie.name, cookieOptions);
      return reply.code(401).send({ code: "unauthenticated" });
    }
    request.session = session;
    request.account = account;
    keepSession(reply, session.id);
    // On the server too, not only in the page's router: a new route is behind it unless it says otherwise.
    if (mustChangePassword(request) && !request.routeOptions.config.beforePasswordChange) {
      return reply.code(403).send({ code: "password_change_required" });
    }
  });

  app.post("/api/auth/login", { config: { public: true } }, async (request, reply) => {
    const body = loginRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    // Only failed attempts count: a successful one gives its two back.
    const byIp = await limiter.take(LOGIN_BY_IP, request.ip);
    if (!byIp.ok) return rateLimited(reply, byIp.retryAfterSeconds);
    const byUsername = await limiter.take(LOGIN_BY_USERNAME, normalizeUsername(body.data.username));
    if (!byUsername.ok) {
      await byIp.giveBack();
      return rateLimited(reply, byUsername.retryAfterSeconds);
    }
    const account = await checkCredentials(body.data.username, body.data.password);
    if (!account) return reply.code(401).send({ code: "invalid_credentials" });
    await Promise.all([byIp.giveBack(), byUsername.giveBack()]);
    // A new session id at every login; the session this browser had, if any, ends.
    const previous = request.cookies[cookie.name];
    if (previous) await sessions.end({ sessionId: previous });
    keepSession(reply, await sessions.start(account.id, "password"));
    return reply.code(204).send();
  });

  app.post("/api/auth/logout", { config: { public: true } }, async (request, reply) => {
    const id = request.cookies[cookie.name];
    if (id) await sessions.end({ sessionId: id });
    reply.clearCookie(cookie.name, cookieOptions);
    return reply.code(204).send();
  });

  // Every device: this session too, and every connection of the account.
  app.post("/api/auth/logout-all", { config: { beforePasswordChange: true } }, async (request, reply) => {
    await sessions.end({ accountId: request.account!.id });
    reply.clearCookie(cookie.name, cookieOptions);
    return reply.code(204).send();
  });
}
