// What an admin does on /admin: making accounts, resetting passwords, disabling and enabling, and
// handing a disabled Owner's score to another member (docs/spec/routes.md, 3.2;
// docs/spec/accounts.md, section 2). Admin is the flag on the account, nothing to do with a
// score's Owner.
import { ResetConnection } from "@hocuspocus/common";
import { adminAccount, adminAccountList, createAccountRequest, orphanedScoreList, resetPasswordRequest, transferRequest } from "@studio/contracts";
import type { FastifyInstance } from "fastify";
import { Op, type WhereOptions } from "sequelize";

import { createAccount, setDisabled, setTemporaryPassword, UsernameTaken } from "./accounts";
import type { Collab } from "./collab";
import { Account, Identity, Score, ScoreMember } from "./db/models";
import { invalidRequest, isUuid, notFound } from "./http";
import { changeMembers, closeFor, handOver, unlessRefused } from "./members";

type AccountParams = { Params: { id: string } };

function shown(account: Account, identities: Identity[]) {
  return {
    accountId: account.id,
    username: account.username,
    displayName: account.displayName,
    isAdmin: account.isAdmin,
    disabled: account.disabledAt !== null,
    identities: identities.map(({ id, provider }) => ({ id, provider })),
  };
}

/**
 * The scores whose Owner is disabled, those of these ids only when given: the Owner's membership
 * with its account and the score's title, by the Owner's username, then title. A deleted score is
 * none of them: to everyone it is not there (docs/spec/security.md, section 8).
 */
function orphanedOwners(scoreIds?: string[]): Promise<ScoreMember[]> {
  const where: WhereOptions<ScoreMember> = scoreIds === undefined ? { role: "owner" } : { role: "owner", scoreId: scoreIds };
  return ScoreMember.findAll({
    where,
    include: [
      { model: Account, as: "account", required: true, where: { disabledAt: { [Op.ne]: null } } },
      // The title only: never the content (docs/spec/accounts.md, section 2).
      { model: Score, as: "score", required: true, where: { deletedAt: null }, attributes: ["id", "title"] },
    ],
    order: [
      [{ model: Account, as: "account" }, "username", "ASC"],
      [{ model: Score, as: "score" }, "title", "ASC"],
      ["scoreId", "ASC"],
    ],
  });
}

export function registerAdmin(app: FastifyInstance, { collab }: { collab: Collab }): void {
  // Every route under /api/admin/, those later tickets add too: to anyone but an admin there is
  // no such thing (docs/spec/security.md, 8). It runs after the hook that found the account.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.routeOptions.url?.startsWith("/api/admin/")) return;
    if (!request.account?.isAdmin) return notFound(reply);
  });

  app.get("/api/admin/accounts", async () => {
    const accounts = await Account.findAll({ include: [{ model: Identity, as: "identities" }], order: [["username", "ASC"]] });
    return adminAccountList.parse({ accounts: accounts.map((account) => shown(account, (account.get("identities") as Identity[] | undefined) ?? [])) });
  });

  app.post("/api/admin/accounts", async (request, reply) => {
    const body = createAccountRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    try {
      // The password is the admin's, a temporary one: its person changes it at the first login.
      const account = await createAccount({ ...body.data, isAdmin: false, mustChangePassword: true });
      const identities = await Identity.findAll({ where: { accountId: account.id } });
      return await reply.code(201).send(adminAccount.parse(shown(account, identities)));
    } catch (error) {
      if (error instanceof UsernameTaken) return reply.code(409).send({ code: "username_taken" });
      throw error;
    }
  });

  app.post<AccountParams>("/api/admin/accounts/:id/reset-password", async (request, reply) => {
    const { id } = request.params;
    // Whether there is such an account comes first: what is wrong with a request about none is that.
    if (!isUuid(id) || !(await Account.findByPk(id))) return notFound(reply);
    const body = resetPasswordRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    if (!(await setTemporaryPassword(id, body.data.password))) return notFound(reply);
    // Whoever is logged in with the old password is out, and the account's connections close.
    await app.sessions.end({ accountId: id });
    return reply.code(204).send();
  });

  app.post<AccountParams>("/api/admin/accounts/:id/disable", async (request, reply) => {
    const { id } = request.params;
    if (!isUuid(id)) return notFound(reply);
    // Or the last admin could lock everyone out of /admin, themselves included.
    if (id === request.account!.id) return reply.code(409).send({ code: "cannot_disable_self" });
    if (!(await setDisabled(id, true))) return notFound(reply);
    await app.sessions.end({ accountId: id });
    return reply.code(204).send();
  });

  app.post<AccountParams>("/api/admin/accounts/:id/enable", async (request, reply) => {
    const { id } = request.params;
    if (!isUuid(id) || !(await setDisabled(id, false))) return notFound(reply);
    return reply.code(204).send();
  });

  app.get("/api/admin/orphaned-scores", async () => {
    const owners = await orphanedOwners();
    // Their members who can log in: those a score can be handed to, in the order they were added.
    const members = await ScoreMember.findAll({
      where: { scoreId: owners.map(({ scoreId }) => scoreId), role: { [Op.ne]: "owner" } },
      include: [{ model: Account, as: "account", required: true, where: { disabledAt: null } }],
      order: [
        ["addedAt", "ASC"],
        [{ model: Account, as: "account" }, "username", "ASC"],
      ],
    });
    const person = (account: Account) => ({ accountId: account.id, username: account.username, displayName: account.displayName });
    return orphanedScoreList.parse({
      scores: owners.map((owner) => ({
        id: owner.scoreId,
        title: (owner.get("score") as Score).title,
        owner: person(owner.get("account") as Account),
        members: members.filter(({ scoreId }) => scoreId === owner.scoreId).map((member) => ({ ...person(member.get("account") as Account), role: member.role })),
      })),
    });
  });

  app.post<AccountParams>("/api/admin/scores/:id/transfer", async (request, reply) => {
    const { id } = request.params;
    // Whether there is such a score comes first: to an admin, a score whose Owner can log in is none.
    if (!isUuid(id) || (await orphanedOwners([id])).length === 0) return notFound(reply);
    const body = transferRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    const to = body.data.accountId;
    return unlessRefused(reply, async () => {
      // As the Owner's own transfer, with the score's row locked: checked again there, the Owner
      // still disabled (docs/spec/routes.md, 3.4).
      const from = await changeMembers(id, { by: "admin" }, async (members) => {
        await handOver(members, to);
        return members.me.accountId;
      });
      // The disabled Owner has none open; the new Owner comes back as the Owner.
      closeFor(collab, id, [from, to], ResetConnection);
      return reply.code(204).send();
    });
  });
}
