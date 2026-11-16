// A score's members (docs/spec/accounts.md, sections 3 to 6; docs/spec/routes.md, 3.3 and 3.4):
// every member reads the list; the Owner adds accounts by username, changes roles, removes
// members and hands the score over; the others leave. Whoever's role changes or ends loses the
// connections opened with it, and only those (docs/spec/accounts.md, section 9).
import { type CloseEvent, Forbidden, ResetConnection } from "@hocuspocus/common";
import { addMemberRequest, changeRoleRequest, type ErrorCode, scoreMember, scoreMemberList, transferRequest } from "@studio/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { Transaction } from "sequelize";

import { normalizeUsername } from "./accounts";
import type { Collab } from "./collab";
import { Account, Score, ScoreMember } from "./db/models";
import { invalidRequest, isUuid, notFound, rateLimited } from "./http";
import { ADD_MEMBER_BY_ACCOUNT, type RateLimiter } from "./rateLimit";
import { membership, ownedScore } from "./scores";

type ScoreParams = { Params: { id: string } };
type MemberParams = { Params: { id: string; accountId: string } };

/** A change of members that is not made: the answer to send instead. */
export class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
  ) {
    super(code);
  }
}

/** The members of a score while they are being changed: the one who asks, and how to find another. */
export interface Members {
  me: ScoreMember;
  /** The member with this account; a `Refusal` (404) when there is none. */
  other(accountId: string): ScoreMember;
  transaction: Transaction;
}

/**
 * Change a score's members as one of them, one change at a time: the score's row is locked first,
 * so that what a change reads (who the Owner is, who is a member) is still so when it writes. Two
 * requests at once could otherwise each pass its checks and leave a score without an Owner, or
 * with a member its Owner of a moment ago added. Refuses with 404 anyone who is no member (or
 * when the score is missing or deleted), and with 403 a member who is not the Owner when the
 * change is the Owner's to make. Every change of `score_members` goes through here, whoever makes
 * it: the lock is what keeps two of them apart.
 */
export async function changeMembers<T>(scoreId: string, accountId: string, by: "owner" | "member", change: (members: Members) => Promise<T>): Promise<T> {
  if (!isUuid(scoreId)) throw new Refusal(404, "not_found");
  return Score.sequelize!.transaction(async (transaction) => {
    const score = await Score.findOne({ where: { id: scoreId, deletedAt: null }, attributes: ["id"], lock: transaction.LOCK.UPDATE, transaction });
    const all = score === null ? [] : await ScoreMember.findAll({ where: { scoreId }, transaction });
    const me = all.find((member) => member.accountId === accountId);
    if (me === undefined) throw new Refusal(404, "not_found");
    if (by === "owner" && me.role !== "owner") throw new Refusal(403, "forbidden");
    const other = (id: string) => {
      const member = all.find((one) => one.accountId === id);
      if (member === undefined) throw new Refusal(404, "not_found");
      return member;
    };
    return change({ me, other, transaction });
  });
}

/** A member as the list shows them. */
function shown(member: Pick<ScoreMember, "role">, account: Account) {
  return { accountId: account.id, username: account.username, displayName: account.displayName, role: member.role, disabled: account.disabledAt !== null };
}

/** Whether Postgres refused a row because one with its key is there already. */
function isDuplicate(error: unknown): boolean {
  return error instanceof Error && error.name === "SequelizeUniqueConstraintError";
}

export function registerMembers(app: FastifyInstance, { collab, limiter }: { collab: Collab; limiter: RateLimiter }): void {
  /** Send the refusal of a change that was not made; anything else that went wrong is the server's fault. */
  async function unlessRefused(reply: FastifyReply, change: () => Promise<unknown>) {
    try {
      return await change();
    } catch (error) {
      if (error instanceof Refusal) return reply.code(error.status).send({ code: error.code });
      throw error;
    }
  }

  /**
   * After the change is committed: the connections these accounts opened to this score are closed,
   * the ones still loading too (docs/spec/collab.md, section 6). Their providers come back with a
   * new ticket, which carries the role they have now, or are refused one.
   */
  function closeFor(scoreId: string, accountIds: string[], event: CloseEvent): void {
    for (const accountId of accountIds) collab.closeConnections({ scoreId, accountId }, event);
  }

  app.get<ScoreParams>("/api/scores/:id/members", async (request, reply) => {
    const member = await membership(request.params.id, request.account!.id);
    if (member === null) return notFound(reply);
    const members = await ScoreMember.findAll({
      where: { scoreId: member.score.id },
      include: [{ model: Account, as: "account", required: true }],
      order: [
        ["addedAt", "ASC"],
        [{ model: Account, as: "account" }, "username", "ASC"],
      ],
    });
    // The Owner first, whoever was added before: after a transfer it is not the oldest member.
    const ordered = [...members.filter(({ role }) => role === "owner"), ...members.filter(({ role }) => role !== "owner")];
    return scoreMemberList.parse({ members: ordered.map((one) => shown(one, one.get("account") as Account)) });
  });

  app.post<ScoreParams>("/api/scores/:id/members", async (request, reply) => {
    // Who may ask comes first: only an Owner's lookups are made, and counted.
    const score = await ownedScore(request, reply);
    if (score === null) return reply;
    const body = addMemberRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    // Every lookup counts, the ones that find an account too: each tells whether a username
    // exists (docs/spec/security.md, section 4).
    const attempt = await limiter.take(ADD_MEMBER_BY_ACCOUNT, request.account!.id);
    if (!attempt.ok) return rateLimited(reply, attempt.retryAfterSeconds);
    // The whole username, read as the login page reads one (`Ben` is `ben`): no directory, no
    // completion (docs/spec/accounts.md, section 4).
    const account = await Account.findOne({ where: { username: normalizeUsername(body.data.username) } });
    if (account === null) return reply.code(404).send({ code: "account_not_found" });
    return unlessRefused(reply, async () => {
      await changeMembers(score.id, request.account!.id, "owner", async ({ transaction }) => {
        try {
          // The Owner too is a member already. A savepoint, so that a refused row leaves the transaction usable.
          await Score.sequelize!.transaction({ transaction }, (nested) => ScoreMember.create({ scoreId: score.id, accountId: account.id, role: body.data.role }, { transaction: nested }));
        } catch (error) {
          if (isDuplicate(error)) throw new Refusal(409, "already_member");
          throw error;
        }
      });
      return reply.code(201).send(scoreMember.parse(shown({ role: body.data.role }, account)));
    });
  });

  app.patch<MemberParams>("/api/scores/:id/members/:accountId", async (request, reply) => {
    const score = await ownedScore(request, reply);
    if (score === null) return reply;
    const body = changeRoleRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    const { role } = body.data;
    const { accountId } = request.params;
    return unlessRefused(reply, async () => {
      const changed = await changeMembers(score.id, request.account!.id, "owner", async ({ other, transaction }) => {
        const member = other(accountId);
        // The Owner changes by transfer only: a score always has one.
        if (member.role === "owner") throw new Refusal(409, "owner_cannot_leave");
        if (member.role === role) return false;
        await ScoreMember.update({ role }, { where: { scoreId: score.id, accountId }, transaction });
        return true;
      });
      // Either way: a connection is read-only or not as the role was when it was let in.
      if (changed) closeFor(score.id, [accountId], ResetConnection);
      const account = await Account.findByPk(accountId);
      if (account === null) throw new Error(`member ${accountId} has no account`);
      return scoreMember.parse(shown({ role }, account));
    });
  });

  app.delete<MemberParams>("/api/scores/:id/members/:accountId", async (request, reply) => {
    const score = await ownedScore(request, reply);
    if (score === null) return reply;
    const { accountId } = request.params;
    return unlessRefused(reply, async () => {
      await changeMembers(score.id, request.account!.id, "owner", async ({ other, transaction }) => {
        if (other(accountId).role === "owner") throw new Refusal(409, "owner_cannot_leave");
        await ScoreMember.destroy({ where: { scoreId: score.id, accountId }, transaction });
      });
      closeFor(score.id, [accountId], Forbidden);
      return reply.code(204).send();
    });
  });

  app.post<ScoreParams>("/api/scores/:id/transfer", async (request, reply) => {
    const score = await ownedScore(request, reply);
    if (score === null) return reply;
    const body = transferRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    const from = request.account!.id;
    const to = body.data.accountId;
    return unlessRefused(reply, async () => {
      await changeMembers(score.id, from, "owner", async ({ other, transaction }) => {
        other(to);
        // To someone else, who can log in (docs/spec/accounts.md, section 5): the settings page offers no other.
        // Its row is held until the transfer is committed: an admin disabling the account at the
        // same moment waits, and never leaves the score with an Owner disabled just before.
        const account = await Account.findByPk(to, { lock: transaction.LOCK.SHARE, transaction });
        if (to === from || account === null || account.disabledAt !== null) throw new Refusal(400, "invalid_request");
        // In this order: a score never has two Owners, not even between two statements. Each must
        // change its one row: a transfer that changed only one would leave no Owner, or two members
        // short of one, so it is undone as a whole.
        for (const [accountId, role, was] of [
          [from, "editor", "owner"],
          [to, "owner", ["editor", "viewer"]],
        ] as const) {
          const [changed] = await ScoreMember.update({ role }, { where: { scoreId: score.id, accountId, role: was }, transaction });
          if (changed !== 1) throw new Error(`transferring score ${score.id}: ${changed} rows of ${accountId} changed, not 1`);
        }
      });
      closeFor(score.id, [from, to], ResetConnection);
      return reply.code(204).send();
    });
  });

  app.post<ScoreParams>("/api/scores/:id/leave", async (request, reply) => {
    const { id } = request.params;
    const accountId = request.account!.id;
    return unlessRefused(reply, async () => {
      await changeMembers(id, accountId, "member", async ({ me, transaction }) => {
        if (me.role === "owner") throw new Refusal(409, "owner_cannot_leave");
        await ScoreMember.destroy({ where: { scoreId: id, accountId }, transaction });
      });
      closeFor(id, [accountId], Forbidden);
      return reply.code(204).send();
    });
  });
}
