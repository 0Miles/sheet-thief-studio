// Read-only links (docs/spec/accounts.md, section 7; docs/spec/routes.md, 3.5): a score's Owner
// makes, copies, makes anew and revokes its link; whoever holds it gets a guest's collab ticket,
// without logging in.
import { Forbidden } from "@hocuspocus/common";
import { guestTicket, scoreLink } from "@studio/contracts";
import type { FastifyInstance } from "fastify";

import type { Collab } from "./collab";
import type { CollabTickets } from "./collabTickets";
import { Score } from "./db/models";
import { notFound, rateLimited } from "./http";
import { changeMembers, unlessRefused } from "./members";
import { GUEST_TICKET_BY_IP, type RateLimiter } from "./rateLimit";
import { ownedScore } from "./scores";
import { routedPath } from "./security";
import { isToken, newToken } from "./tokens";

/** The page of a read-only link and the API behind it, with the token as the segment after `s/`. */
const LINK_PATH = /^(\/(?:api\/)?s\/)[^/]*/;

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

/** The score the token is the read-only link of (its id and title only); null when it is none, or the score is deleted. */
export async function scoreOfLink(token: string): Promise<Score | null> {
  if (!isToken(token)) return null;
  return Score.findOne({ where: { linkToken: token, deletedAt: null }, attributes: ["id", "title"] });
}

/**
 * Give the score this link token (null: none) as its Owner, and return the one it had. Its column
 * only: the score's `updated_at` stays. With the score's row locked, and its Owner checked only
 * then (`changeMembers`): two requests at once cannot both replace the same token and leave the
 * connections of the one between them open; an Owner who hands the score over meanwhile is
 * refused with 403 once the transfer is committed; and a score deleted meanwhile (404) gets no
 * link, which a restoration would bring back with it (docs/spec/accounts.md, section 8).
 */
async function replaceLink(scoreId: string, accountId: string, token: string | null): Promise<string | null> {
  return changeMembers(scoreId, { accountId, by: "owner" }, async ({ transaction }) => {
    const score = await Score.findByPk(scoreId, { attributes: ["linkToken"], transaction });
    await Score.update({ linkToken: token }, { where: { id: scoreId }, silent: true, transaction });
    return score!.linkToken;
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
    // Read here only: the token is a secret, not part of what every membership check loads. In
    // the same statement as the check: the Owner of a moment ago never reads the token the new
    // Owner makes once the score is handed over.
    const score = await ownedScore(request, reply, ["id", "linkToken"]);
    if (score === null) return reply;
    return scoreLink.parse({ token: score.linkToken ?? null });
  });

  // Making a link anew revokes the one before (docs/spec/accounts.md, section 7).
  app.post<{ Params: { id: string } }>("/api/scores/:id/link", async (request, reply) =>
    unlessRefused(reply, async () => {
      const token = newToken();
      revoked(request.params.id, await replaceLink(request.params.id, request.account!.id, token));
      return scoreLink.parse({ token });
    }),
  );

  app.delete<{ Params: { id: string } }>("/api/scores/:id/link", async (request, reply) =>
    unlessRefused(reply, async () => {
      revoked(request.params.id, await replaceLink(request.params.id, request.account!.id, null));
      return reply.code(204).send();
    }),
  );

  // A POST, so that it goes through the Origin check (docs/spec/routes.md, 3.5).
  app.post<{ Params: { token: string } }>("/api/s/:token", { config: { public: true } }, async (request, reply) => {
    // Every attempt counts, the ones that find a score too.
    const attempt = await limiter.take(GUEST_TICKET_BY_IP, request.ip);
    if (!attempt.ok) return rateLimited(reply, attempt.retryAfterSeconds);
    const { token } = request.params;
    // Wrong, revoked, or the score deleted: all the same 404.
    const score = await scoreOfLink(token);
    if (score === null) return notFound(reply);
    const ticket = await tickets.issue({ kind: "guest", scoreId: score.id, linkToken: token });
    return guestTicket.parse({ scoreId: score.id, title: score.title, ticket });
  });
}
