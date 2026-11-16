import cookie from "@fastify/cookie";
import { health } from "@studio/contracts";
import type { Migration } from "@studio/score-model";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

import { registerAdmin } from "./admin";
import { registerAuth } from "./auth";
import { attachCollab } from "./collab";
import { CollabTickets } from "./collabTickets";
import type { Config } from "./config";
import { registerDeletion } from "./deletion";
import { registerErrorAnswers, registerOriginCheck } from "./http";
import { JSON_BODY_LIMIT } from "./limits";
import { registerMe } from "./me";
import { registerLinks, withoutLinkTokens } from "./links";
import { registerMembers } from "./members";
import { registerPhrases } from "./phrases";
import { RateLimiter } from "./rateLimit";
import { registerScores } from "./scores";
import { registerPages, registerSecurityHeaders } from "./security";
import { Sessions } from "./sessions";

export interface Dependencies {
  config: Config;
  /** Connected; the caller closes it after the app (main.ts). */
  redis: Redis;
  logger?: boolean;
  /** The steps of the score schema, for the tests that register their own; the published ones otherwise. */
  migrations?: readonly Migration[];
}

/** The HTTP API and the co-editing server. The database is the one `connectDatabase` bound the models to. */
export function buildApp({ config, redis, logger = true, migrations }: Dependencies): FastifyInstance {
  // Only nginx stands in front of the server: the client's IP is the address nginx adds to
  // X-Forwarded-For (docs/spec/security.md, 4).
  // JSON requests carry at most 64 KB; the routes that carry a fragment set their own limit (docs/spec/security.md, section 5).
  const app = Fastify({ logger: logger ? { serializers: { req: loggedRequest } } : false, trustProxy: config.trustedProxies, bodyLimit: JSON_BODY_LIMIT });
  // First: the answers of every hook after it carry the headers too.
  registerSecurityHeaders(app, { hsts: config.hsts });
  app.register(cookie);
  registerErrorAnswers(app);
  registerOriginCheck(app, config.publicOrigin);
  // Liveness only: says the process answers, not that its dependencies do.
  app.get("/healthz", async () => health.parse({ status: "ok" }));
  const sessions = new Sessions(redis, app.log);
  const tickets = new CollabTickets(redis);
  const limiter = new RateLimiter(redis);
  registerAuth(app, { cookie: config.sessionCookie, sessions, limiter });
  registerMe(app, { limiter });
  registerAdmin(app);
  const collab = attachCollab(app, { tickets, sessions, migrations });
  registerScores(app, { collab, tickets, limiter });
  registerMembers(app, { collab, limiter });
  registerDeletion(app, { collab });
  registerLinks(app, { collab, tickets, limiter });
  registerPhrases(app);
  if (config.webRoot !== null) registerPages(app, config.webRoot);
  return app;
}

/** A request as the log shows it: Fastify's own fields, the URL without a read-only link's token. */
function loggedRequest(request: FastifyRequest) {
  return {
    method: request.method,
    url: withoutLinkTokens(request.url),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  };
}
