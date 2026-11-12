import { health } from "@studio/contracts";
import Fastify, { type FastifyInstance } from "fastify";

export function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });
  // Liveness only: says the process answers, not that its dependencies do.
  app.get("/healthz", async () => health.parse({ status: "ok" }));
  return app;
}
