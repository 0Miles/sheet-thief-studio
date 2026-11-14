// Read-only links (docs/spec/accounts.md, section 7; docs/spec/routes.md, 3.5): a score's Owner
// makes, copies, makes anew and revokes its link; whoever holds it gets a guest's collab ticket,
// without logging in.
import { Forbidden } from "@hocuspocus/common";
import { guestTicket, scoreLink } from "@studio/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { Collab } from "./collab";
import type { CollabTickets } from "./collabTickets";
import { Score } from "./db/models";
import { rateLimited } from "./http";
import { GUEST_TICKET_BY_IP, type RateLimiter } from "./rateLimit";
import { membership, notFound } from "./scores";
import { isToken, newToken } from "./tokens";

/** The page of a read-only link and the API behind it, with the token as the segment after `s/`. */
const LINK_PATH = /^(\/(?:api\/)?s\/)[^/]*/;

/** The path of a URL as the router matches it: decoded. */
function routedPath(url: string): string {
  const path = url.split("?", 1)[0]!;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * The URL as the logs may show it: without the token of a read-only link, in the path or in a
 * `token` parameter (docs/spec/security.md, section 9).
 */
export function withoutLinkTokens(url: string): string {
  const at = url.indexOf("?");
  const query = at === -1 ? "" : url.slice(at);
  const path = routedPath(url);
  const shown = LINK_PATH.test(path) ? path.replace(LINK_PATH, "$1[token]") : url.slice(0, url.length - query.length);
  return shown + query.replace(/([?&]token=)[^&#]*/g, "$1[token]");
}

/** Whether the token is the read-only link of this score, and the score is not deleted. */
export async function isLinkOf(scoreId: string, token: string): Promise<boolean> {
  return isToken(token) && (await Score.count({ where: { id: scoreId, linkToken: token, deletedAt: null } })) === 1;
}

/**
 * The score when the session's account is its Owner; otherwise null, the refusal sent: 404 to
 * anyone who is no member (docs/spec/security.md, section 8), 403 to the other members.
 */
async function ownedScore(request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<Score | null> {
  const member = await membership(request.params.id, request.account!.id);
  if (member?.role === "owner") return member.score;
  if (member === null) notFound(reply);
  else reply.code(403).send({ code: "forbidden" });
  return null;
}

/** Give the score this link token (null: none), and return the one it had. Its column only: the score's `updated_at` stays. */
async function replaceLink(scoreId: string, token: string | null): Promise<string | null> {
  return Score.sequelize!.transaction(async (transaction) => {
    // Locked, so that two requests at once cannot both replace the same token and leave the
    // connections of the one between them open.
    const score = await Score.findByPk(scoreId, { attributes: ["id", "linkToken"], lock: transaction.LOCK.UPDATE, transaction });
    await Score.update({ linkToken: token }, { where: { id: scoreId }, silent: true, transaction });
    return score?.linkToken ?? null;
  });
}

export function registerLinks(app: FastifyInstance, { collab, tickets, limiter }: { collab: Collab; tickets: CollabTickets; limiter: RateLimiter }): void {
  /** A link token that stops opening the score takes the connections it opened along (docs/spec/accounts.md, section 9). */
  const revoked = (scoreId: string, token: string | null) => {
    if (token !== null) collab.closeConnections({ scoreId, linkToken: token }, Forbidden);
  };

  // Whatever the rest of the site does, these answers send no referrer on (the token is in the
  // URL) and are not indexed (docs/spec/security.md, section 6): every answer, errors included.
  app.addHook("onSend", async (request, reply, payload) => {
    if (LINK_PATH.test(routedPath(request.url))) reply.header("referrer-policy", "no-referrer").header("x-robots-tag", "noindex");
    return payload;
  });

  app.get<{ Params: { id: string } }>("/api/scores/:id/link", async (request, reply) => {
    const score = await ownedScore(request, reply);
    if (score === null) return reply;
    // Read here only: the token is a secret, not part of what every membership check loads.
    const stored = await Score.findByPk(score.id, { attributes: ["linkToken"] });
    return scoreLink.parse({ token: stored?.linkToken ?? null });
  });

  // Making a link anew revokes the one before (docs/spec/accounts.md, section 7).
  app.post<{ Params: { id: string } }>("/api/scores/:id/link", async (request, reply) => {
    const score = await ownedScore(request, reply);
    if (score === null) return reply;
    const token = newToken();
    revoked(score.id, await replaceLink(score.id, token));
    return scoreLink.parse({ token });
  });

  app.delete<{ Params: { id: string } }>("/api/scores/:id/link", async (request, reply) => {
    const score = await ownedScore(request, reply);
    if (score === null) return reply;
    revoked(score.id, await replaceLink(score.id, null));
    return reply.code(204).send();
  });

  // A POST, so that it goes through the Origin check (docs/spec/routes.md, 3.5).
  app.post<{ Params: { token: string } }>("/api/s/:token", { config: { public: true } }, async (request, reply) => {
    // Every attempt counts, the ones that find a score too.
    const attempt = await limiter.take(GUEST_TICKET_BY_IP, request.ip);
    if (!attempt.ok) return rateLimited(reply, attempt.retryAfterSeconds);
    const { token } = request.params;
    // Wrong, revoked, or the score deleted: all the same 404.
    const score = isToken(token) ? await Score.findOne({ where: { linkToken: token, deletedAt: null }, attributes: ["id", "title"] }) : null;
    if (score === null) return notFound(reply);
    const ticket = await tickets.issue({ scoreId: score.id, linkToken: token });
    return guestTicket.parse({ scoreId: score.id, title: score.title, ticket });
  });
}
