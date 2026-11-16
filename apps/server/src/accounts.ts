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

const newAccount = z.object({
  username,
  displayName,
  password,
  isAdmin: z.boolean(),
  /** True for an account an admin made with a temporary password; false when the person it is for chose it. */
  mustChangePassword: z.boolean(),
});

export type NewAccount = z.input<typeof newAccount>;

/**
 * Create an account and its password identity in one transaction. Throws a ZodError when a field
 * breaks the rules, and UsernameTaken when the username exists.
 */
export async function createAccount(input: NewAccount): Promise<Account> {
  const { password: secret, ...fields } = newAccount.parse(input);
  const secretHash = await hashPassword(secret);
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
  if (!account || !identity?.secretHash) {
    await verifyNothing(typedPassword);
    return null;
  }
  const matches = await verifyPassword(identity.secretHash, typedPassword);
  return matches && account.disabledAt === null ? account : null;
}

/** Whether this is the account's password, for someone already logged in who is asked for it again. */
export async function isPasswordOf(accountId: string, typedPassword: string): Promise<boolean> {
  const identity = await Identity.findOne({ where: { accountId, provider: "password" } });
  if (!identity?.secretHash) {
    await verifyNothing(typedPassword);
    return false;
  }
  return verifyPassword(identity.secretHash, typedPassword);
}

/**
 * Give the account the password its own person chose: with it, nothing is left to change. The
 * caller has checked the password against the rules, and ends the account's other sessions.
 */
export async function chooseOwnPassword(accountId: string, newPassword: string): Promise<void> {
  const secretHash = await hashPassword(newPassword);
  await Account.sequelize!.transaction(async (transaction) => {
    const [changed] = await Identity.update({ secretHash }, { where: { accountId, provider: "password" }, transaction });
    if (changed !== 1) throw new Error(`account ${accountId} has no password to change`);
    await Account.update({ mustChangePassword: false }, { where: { id: accountId }, transaction });
  });
}

/**
 * Give the account a temporary password, an admin's: its person must change it at the next login.
 * False when there is no such account. The caller has checked the password against the rules,
 * and ends the account's sessions.
 */
export async function setTemporaryPassword(accountId: string, temporaryPassword: string): Promise<boolean> {
  const secretHash = await hashPassword(temporaryPassword);
  return Account.sequelize!.transaction(async (transaction) => {
    const [found] = await Account.update({ mustChangePassword: true }, { where: { id: accountId }, transaction });
    if (found !== 1) return false;
    const [changed] = await Identity.update({ secretHash }, { where: { accountId, provider: "password" }, transaction });
    // An account that only logged in another way gets a password to log in with.
    if (changed === 0) await Identity.create({ accountId, provider: "password", subject: accountId, secretHash }, { transaction });
    return true;
  });
}

/**
 * Disable the account, or enable it again: a disabled account cannot log in. False when there is
 * no such account. One already disabled stays disabled since when it was. The caller ends the
 * sessions of an account it disables.
 */
export async function setDisabled(accountId: string, disabled: boolean): Promise<boolean> {
  const account = await Account.findByPk(accountId);
  if (!account) return false;
  if (disabled !== (account.disabledAt !== null)) await account.update({ disabledAt: disabled ? new Date() : null });
  return true;
}
