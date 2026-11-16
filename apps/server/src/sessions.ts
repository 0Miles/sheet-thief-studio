// Sessions in Redis (docs/spec/security.md, section 1): `session:<id>` holds the account, and
// `account-sessions:<accountId>` lists the ids of an account so that all of them can end at once.
// Both slide: every use moves their expiry 30 days ahead.
import type { Redis } from "ioredis";

import { isToken, newToken } from "./tokens";

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface Session {
  id: string;
  accountId: string;
  createdAt: string;
}

/**
 * Which sessions ended: one (`sessionId`, on logging out), or every session of the account
 * (`sessionId` null) — and with them every connection the account has, those of a session that
 * was kept included (they reconnect with a new ticket), and those whose document is still loading.
 *
 * The account of one session is null when Redis did not say whose it was (its reply to deleting
 * the session was lost, or what it stored cannot be read): the session id is all a listener has.
 */
export type SessionsEnded = { accountId: string; sessionId: null } | { accountId: string | null; sessionId: string };

export type SessionsEndedListener = (ended: SessionsEnded) => void | Promise<void>;

/** One session, or every session of an account but the one it keeps (changing one's own password). */
export type SessionsToEnd = { sessionId: string } | { accountId: string; except?: string };

interface Logger {
  error(details: object, message: string): void;
}

const sessionKey = (id: string) => `session:${id}`;
const accountKey = (accountId: string) => `account-sessions:${accountId}`;

export class Sessions {
  readonly #listeners = new Set<SessionsEndedListener>();

  constructor(
    private readonly redis: Redis,
    private readonly log: Logger,
  ) {}

  async start(accountId: string): Promise<string> {
    const id = newToken();
    const session = { accountId, createdAt: new Date().toISOString() };
    await this.redis
      .multi()
      .set(sessionKey(id), JSON.stringify(session), "EX", SESSION_TTL_SECONDS)
      .sadd(accountKey(accountId), id)
      .expire(accountKey(accountId), SESSION_TTL_SECONDS)
      .exec();
    return id;
  }

  /** The session with this id, its expiry moved 30 days ahead; null when there is none. */
  async resume(id: string): Promise<Session | null> {
    if (!isToken(id)) return null;
    const stored = await this.redis.getex(sessionKey(id), "EX", SESSION_TTL_SECONDS);
    if (stored === null) return null;
    const { accountId, createdAt } = JSON.parse(stored) as Omit<Session, "id">;
    // The list of the account's sessions outlives each of them.
    await this.redis.expire(accountKey(accountId), SESSION_TTL_SECONDS);
    return { id, accountId, createdAt };
  }

  /** Whether the session with this id has not ended. Unlike `resume`, it does not move the expiry. */
  async isActive(id: string): Promise<boolean> {
    return isToken(id) && (await this.redis.exists(sessionKey(id))) === 1;
  }

  /**
   * End sessions, then tell every listener. Every way a session stops being valid comes through
   * here: logging out, logging out everywhere, a password changed or reset, an account disabled.
   */
  async end(which: SessionsToEnd): Promise<void> {
    if ("sessionId" in which) {
      if (!isToken(which.sessionId)) return;
      const { sessionId } = which;
      // Once Redis is asked to delete the session, it may be gone whatever comes back (a reply
      // can be lost after the deletion ran): its connections close unless Redis answered that
      // there was no such session. Better closed than left open; the error still reaches the caller.
      let stored: string | null;
      try {
        stored = await this.redis.getdel(sessionKey(sessionId));
      } catch (error) {
        await this.#notify({ accountId: null, sessionId });
        throw error;
      }
      if (stored === null) return;
      // The session is gone from here on: its connections close even when the bookkeeping fails.
      const accountId = this.#accountOf(stored);
      try {
        if (accountId !== null) await this.redis.srem(accountKey(accountId), sessionId);
      } finally {
        await this.#notify({ accountId, sessionId });
      }
      return;
    }
    const { accountId, except } = which;
    const ending = (await this.redis.smembers(accountKey(accountId))).filter((id) => id !== except);
    const removal = this.redis.multi();
    for (const id of ending) removal.del(sessionKey(id));
    if (except === undefined) removal.del(accountKey(accountId));
    else if (ending.length > 0) removal.srem(accountKey(accountId), ...ending);
    // Whether or not Redis took all of it, the connections close: better closed than left open.
    try {
      await removal.exec();
    } finally {
      await this.#notify({ accountId, sessionId: null });
    }
  }

  /** Be told whenever sessions end; returns the function that stops it. */
  onEnd(listener: SessionsEndedListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Whose session this was, from what Redis stored; null (and logged) when that cannot be read. */
  #accountOf(stored: string): string | null {
    try {
      const { accountId } = JSON.parse(stored) as { accountId?: unknown } | null ?? {};
      if (typeof accountId === "string") return accountId;
    } catch {
      // Not JSON: the same as JSON without an account.
    }
    this.log.error({}, "an ended session's stored value names no account");
    return null;
  }

  async #notify(ended: SessionsEnded): Promise<void> {
    // The sessions have ended whatever a listener does: one failing does not stop the others.
    const results = await Promise.allSettled([...this.#listeners].map(async (listener) => listener(ended)));
    for (const result of results) {
      if (result.status === "rejected") this.log.error({ err: result.reason, ended }, "a listener to ended sessions failed");
    }
  }
}
