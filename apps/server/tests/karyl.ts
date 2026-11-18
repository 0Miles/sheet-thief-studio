// What the karyl-chan tests share: a stand-in for the bot's JWT signing authority, and the plugin
// as the rest of the server sees it (docs/spec/karyl-login.md, section 6).
import { generateKeyPairSync, type KeyObject, randomUUID, sign } from "node:crypto";

import type { Karyl } from "../src/karylPlugin";

/** An Ed25519 key pair like the bot's; the public half as the SPKI PEM the bot hands out. */
export function signingAuthority(): { privateKey: KeyObject; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

const segment = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * A `plugin-session` token as the bot mints one for `userId`, valid `ttlSeconds` from now. `header`
 * and `claims` replace what the bot would write, for the tokens that are not one. The bot writes
 * no `jti`, so its two tokens of one person in one second are the same; the tests' tokens carry one
 * so that each is a link of its own.
 */
export function pluginSession(privateKey: KeyObject, userId: string, { ttlSeconds = 120, header = {}, claims = {} }: { ttlSeconds?: number; header?: object; claims?: object } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const head = segment({ alg: "EdDSA", typ: "JWT", ...header });
  const body = segment({ purpose: "plugin-session", userId, guildId: null, capabilities: [], iat: now, exp: now + ttlSeconds, jti: randomUUID(), ...claims });
  return `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}

/** The plugin registered with a bot whose public key is `publicPem` (null: not yet registered), served under `/plugin/sheet-thief-studio/`. */
export function registeredPlugin(publicPem: string | null): Karyl {
  return { sessionVerifyKey: () => publicPem, basePath: () => "/plugin/sheet-thief-studio/", dispatcher: () => null };
}

/** A Discord id: a snowflake. */
export const DISCORD_ID = "123456789012345678";
