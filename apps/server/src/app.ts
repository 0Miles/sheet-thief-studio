import { health } from "@studio/contracts";
import Fastify, { type FastifyInstance } from "fastify";

import { attachCollab } from "./collab";

export function buildApp({ logger = true }: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger });
  // Liveness only: says the process answers, not that its dependencies do.
  app.get("/healthz", async () => health.parse({ status: "ok" }));
  attachCollab(app);
  return app;
}
