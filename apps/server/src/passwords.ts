// Password hashing: argon2id with the parameters of docs/spec/security.md, section 3. These are
// also the library's defaults; they are spelled out so a library update cannot change them.
import { hash, verify } from "@node-rs/argon2";

const PARAMETERS = { memoryCost: 19456, timeCost: 2, parallelism: 1 }; // the algorithm defaults to argon2id

export function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMETERS);
}

/** Whether the password matches the hash; false for a hash that cannot be read. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let decoy: Promise<string> | undefined;

/**
 * Spend the time of a real check when there is no hash to check against (no such account), so
 * that how long a login takes does not tell whether the account exists.
 */
export async function verifyNothing(password: string): Promise<false> {
  decoy ??= hashPassword("not the password of any account");
  await verifyPassword(await decoy, password);
  return false;
}
