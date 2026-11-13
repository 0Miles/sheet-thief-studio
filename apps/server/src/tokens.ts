// The random values the server hands out as bearer secrets: session ids and collab tickets.
import { randomBytes } from "node:crypto";

/** 32 random bytes in base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Whether the value could be a token at all, checked before asking Redis about it. */
export function isToken(value: string): boolean {
  return TOKEN.test(value);
}
