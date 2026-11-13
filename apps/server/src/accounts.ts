// Accounts and their passwords (docs/spec/accounts.md, section 1; ADR 0004).
import { displayName, password, username } from "@studio/contracts";
import { UniqueConstraintError } from "sequelize";
import { z } from "zod";

import { Account, Identity } from "./db/models";
import { hashPassword, verifyNothing, verifyPassword } from "./passwords";

export class UsernameTaken extends Error {
  constructor(readonly username: string) {
    super(`username ${username} is taken`);
  }
}

const newAccount = z.object({ username, displayName, password });

export interface NewAccount {
  username: string;
  displayName: string;
  password: string;
  isAdmin: boolean;
  /** True for an account an admin made with a temporary password; false when the person it is for chose it. */
  mustChangePassword: boolean;
}

/**
 * Create an account and its password identity in one transaction. Throws a ZodError when a field
 * breaks the rules, and UsernameTaken when the username exists.
 */
export async function createAccount(input: NewAccount): Promise<Account> {
  const valid = newAccount.parse(input);
  const fields = { username: valid.username, displayName: valid.displayName, isAdmin: input.isAdmin, mustChangePassword: input.mustChangePassword };
  const secretHash = await hashPassword(valid.password);
  try {
    return await Account.sequelize!.transaction(async (transaction) => {
      const account = await Account.create(fields, { transaction });
      await Identity.create({ accountId: account.id, provider: "password", subject: account.id, secretHash }, { transaction });
      return account;
    });
  } catch (error) {
    if (error instanceof UniqueConstraintError) throw new UsernameTaken(fields.username);
    throw error;
  }
}

/** The username as typed, in the form it is stored in (usernames are lowercase). */
export function normalizeUsername(typed: string): string {
  return typed.trim().toLowerCase();
}

/**
 * The account these credentials open, or null. Null says nothing more: no such account, a wrong
 * password and a disabled account look the same, and take about as long.
 */
export async function checkCredentials(typedUsername: string, typedPassword: string): Promise<Account | null> {
  const account = await Account.findOne({
    where: { username: normalizeUsername(typedUsername) },
    include: [{ model: Identity, as: "identities", where: { provider: "password" }, required: true }],
  });
  const identity = (account?.get("identities") as Identity[] | undefined)?.[0];
  if (!account || !identity?.secretHash) return verifyNothing(typedPassword).then(() => null);
  const matches = await verifyPassword(identity.secretHash, typedPassword);
  return matches && account.disabledAt === null ? account : null;
}
