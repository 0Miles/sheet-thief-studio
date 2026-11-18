// Logging in from a link of the karyl-chan bot (docs/spec/karyl-login.md, sections 1, 2, 4 and 5):
// `GET /auth/karyl?token=…` checks the `plugin-session` token, finds the account its Discord id is
// bound to, and starts a session, which the page then shows as a Bearer token. A server route:
// the token never reaches the page's scripts.
import { createHash } from "node:crypto";

import { verifyPluginSession } from "@karyl-chan/plugin-sdk";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Redis } from "ioredis";

import { Account, Identity } from "./db/models";
import { type Karyl, LOGIN_PATH } from "./karylPlugin";
import { KARYL_LOGIN_BY_IP, type RateLimiter } from "./rateLimit";
import type { Sessions } from "./sessions";

/** How far the bot's clock may be ahead of ours when a used token is remembered. */
const CLOCK_SKEW_SECONDS = 5;

/**
 * Why a link logged nobody in, as /login reads it: the Discord id no account is bound to, a
 * disabled account, a token that is not one (forged, expired, used), too many such links.
 */
export type KarylFailure = `unbound:${string}` | "disabled" | "invalid" | "rate_limited";

type Outcome = { sessionId: string } | { failure: KarylFailure };

/**
 * Where the browser goes next. Relative to the link (`<base>/auth/karyl`), so the plugin's base
 * path, which only the bot's proxy sees, stays in the address. In the fragment, which no server
 * receives nor logs, and which the page takes out of the address at once.
 */
const SIGNED_IN = (sessionId: string) => `../#session=${sessionId}`;
const REFUSED = (failure: KarylFailure) => `../login#karyl=${encodeURIComponent(failure)}`;

/** The token's `exp`, in seconds; read once its signature has been checked. */
function expiryOf(token: string): number {
  const body = token.split(".")[1] ?? "";
  const { exp } = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { exp: number };
  return exp;
}

const usedKey = (token: string) => `karyl-login-used:${createHash("sha256").update(token).digest("hex")}`;

export function registerKarylLogin(app: FastifyInstance, { karyl, sessions, limiter, redis }: { karyl: Karyl; sessions: Sessions; limiter: RateLimiter; redis: Redis }): void {
  /** A link opens once: the first time it is used is remembered until it would have expired anyway. */
  async function firstUse(token: string): Promise<boolean> {
    const seconds = Math.max(1, expiryOf(token) - Math.floor(Date.now() / 1000) + CLOCK_SKEW_SECONDS);
    return (await redis.set(usedKey(token), "1", "EX", seconds, "NX")) === "OK";
  }

  async function logIn(token: string): Promise<Outcome> {
    const claims = verifyPluginSession(token, karyl.sessionVerifyKey());
    if (claims === null || !(await firstUse(token))) return { failure: "invalid" };
    const identity = await Identity.findOne({ where: { provider: "karyl-chan", subject: claims.userId } });
    // Never an account made for whoever asks: an admin binds the id first (docs/spec/karyl-login.md, section 4).
    if (identity === null) return { failure: `unbound:${claims.userId}` };
    const account = await Account.findByPk(identity.accountId);
    if (account === null || account.disabledAt !== null) return { failure: "disabled" };
    return { sessionId: await sessions.start(account.id, "karyl-chan") };
  }

  app.get<{ Querystring: { token?: unknown } }>(LOGIN_PATH, async (request, reply: FastifyReply) => {
    reply.header("cache-control", "no-store");
    // Only links that log nobody in count, as with passwords.
    const byIp = await limiter.take(KARYL_LOGIN_BY_IP, request.ip);
    if (!byIp.ok) return reply.redirect(REFUSED("rate_limited"), 302);
    const { token } = request.query;
    const outcome = typeof token === "string" ? await logIn(token) : ({ failure: "invalid" } as const);
    if ("failure" in outcome) return reply.redirect(REFUSED(outcome.failure), 302);
    await byIp.giveBack();
    return reply.redirect(SIGNED_IN(outcome.sessionId), 302);
  });
}
