// What an admin does on /admin: making accounts, resetting passwords, disabling and enabling
// (docs/spec/routes.md, 3.2; docs/spec/accounts.md, section 2). Admin is the flag on the account,
// nothing to do with a score's Owner.
import { adminAccount, adminAccountList, createAccountRequest, resetPasswordRequest } from "@studio/contracts";
import type { FastifyInstance } from "fastify";

import { createAccount, setDisabled, setTemporaryPassword, UsernameTaken } from "./accounts";
import { Account, Identity } from "./db/models";
import { invalidRequest, isUuid, notFound } from "./http";

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

export function registerAdmin(app: FastifyInstance): void {
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
    const body = resetPasswordRequest.safeParse(request.body);
    if (!body.success) return invalidRequest(reply, body.error);
    const { id } = request.params;
    if (!isUuid(id) || !(await setTemporaryPassword(id, body.data.password))) return notFound(reply);
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
}
