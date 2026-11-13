import cookie from "@fastify/cookie";
import { health } from "@studio/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import type { Redis } from "ioredis";

import { registerAuth } from "./auth";
import { attachCollab } from "./collab";
import { CollabTickets } from "./collabTickets";
import type { Config } from "./config";
import { registerErrorAnswers, registerOriginCheck } from "./http";
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
  const app = Fastify({ logger, trustProxy: config.trustedProxies });
  app.register(cookie);
  registerErrorAnswers(app);
  registerOriginCheck(app, config.publicOrigin);
  // Liveness only: says the process answers, not that its dependencies do.
  app.get("/healthz", async () => health.parse({ status: "ok" }));
  const sessions = new Sessions(redis, app.log);
  const tickets = new CollabTickets(redis);
  registerAuth(app, { cookie: config.sessionCookie, sessions, limiter: new RateLimiter(redis) });
  const collab = attachCollab(app, { tickets, sessions });
  registerScores(app, { collab, tickets });
  return app;
}
