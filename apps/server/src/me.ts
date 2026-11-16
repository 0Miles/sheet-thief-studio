// One's own account: who the session belongs to, its display name and its password
// (docs/spec/routes.md, 3.1; docs/spec/accounts.md, section 1).
import { changePasswordRequest, me, updateMeRequest } from "@studio/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";

import { chooseOwnPassword, isPasswordOf } from "./accounts";
import { mustChangePassword } from "./auth";
import { invalidRequest, rateLimited } from "./http";
import { OWN_PASSWORD_BY_ACCOUNT, type RateLimiter } from "./rateLimit";

/** The request of someone who is asked for the current password too. */
const withCurrentPassword = changePasswordRequest.required({ currentPassword: true });

/**
 * The account as its own person sees it. `mustChangePassword` is about this session: false for
 * one that did not log in with the password, which is not held to changing it.
 */
function meOf(request: FastifyRequest) {
  const account = request.account!;
  return me.parse({
    accountId: account.id,
    username: account.username,
    displayName: account.displayName,
    isAdmin: account.isAdmin,
    mustChangePassword: mustChangePassword(request),
  });
}

export function registerMe(app: FastifyInstance, { limiter }: { limiter: RateLimiter }): void {
  app.get("/api/me", { config: { beforePasswordChange: true } }, async (request) => meOf(request));

  app.patch("/api/me", async (request, reply) => {
    const body = updateMeRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    await request.account!.update({ displayName: body.data.displayName });
    return meOf(request);
  });

  app.post("/api/me/password", { config: { beforePasswordChange: true } }, async (request, reply) => {
    const body = changePasswordRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    const { currentPassword, newPassword } = body.data;
    const accountId = request.account!.id;
    // Someone who just logged in with a temporary password is not asked for it again; anyone
    // else is, so that a session left open is not enough to take the account over.
    if (!mustChangePassword(request)) {
      if (currentPassword === undefined) return invalidRequest(reply, withCurrentPassword.safeParse(request.body).error!);
      // Only wrong guesses count: a right one gives its attempt back.
      const attempt = await limiter.take(OWN_PASSWORD_BY_ACCOUNT, accountId);
      if (!attempt.ok) return rateLimited(reply, attempt.retryAfterSeconds);
      if (!(await isPasswordOf(accountId, currentPassword))) return reply.code(403).send({ code: "wrong_current_password" });
      await attempt.giveBack();
    }
    await chooseOwnPassword(accountId, newPassword);
    // This session stays; the account's other sessions end, and all its connections close, this
    // session's too: they come back with a new ticket (docs/spec/accounts.md, section 9).
    // The password is changed whatever happens next. Should ending the sessions fail, the answer
    // is still that it changed: told otherwise, they would try again with a current password
    // that no longer is. The connections were closed all the same (`end` tells its listeners
    // either way); what may be left is another session, until it expires: logged, to be ended by hand.
    try {
      await app.sessions.end({ accountId, except: request.session!.id });
    } catch (error) {
      request.log.error({ err: error, accountId }, "the password changed, but the account's other sessions may not have ended");
    }
    return reply.code(204).send();
  });
}
