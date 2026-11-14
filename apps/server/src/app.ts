import cookie from "@fastify/cookie";
import { health } from "@studio/contracts";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { Redis } from "ioredis";

import { registerAuth } from "./auth";
import { attachCollab } from "./collab";
import { CollabTickets } from "./collabTickets";
import type { Config } from "./config";
import { registerErrorAnswers, registerOriginCheck } from "./http";
import { registerLinks, withoutLinkTokens } from "./links";
import { RateLimiter } from "./rateLimit";
import { registerScores } from "./scores";
import { Sessions } from "./sessions";

export interface Dependencies {
  config: Config;
  /** Connected; the caller closes it after the app (main.ts). */
  redis: Redis;
  logger?: boolean;
}

/** The HTTP API and the co-editing server. The database is the one `connectDatabase` bound the models to. */
export function buildApp({ config, redis, logger = true }: Dependencies): FastifyInstance {
  // Only nginx stands in front of the server: the client's IP is the address nginx adds to
  // X-Forwarded-For (docs/spec/security.md, 4).
  const app = Fastify({ logger: logger ? { serializers: { req: loggedRequest } } : false, trustProxy: config.trustedProxies });
  app.register(cookie);
  registerErrorAnswers(app);
  registerOriginCheck(app, config.publicOrigin);
  // Liveness only: says the process answers, not that its dependencies do.
  app.get("/healthz", async () => health.parse({ status: "ok" }));
  const sessions = new Sessions(redis, app.log);
  const tickets = new CollabTickets(redis);
  const limiter = new RateLimiter(redis);
  registerAuth(app, { cookie: config.sessionCookie, sessions, limiter });
  const collab = attachCollab(app, { tickets, sessions });
  registerScores(app, { collab, tickets });
  registerLinks(app, { collab, tickets, limiter });
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
