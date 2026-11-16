// Rate limits counted in Redis over fixed windows (docs/spec/security.md, section 4).
import type { Redis } from "ioredis";

export interface Limit {
  /** Part of the Redis key: one name per limit. */
  name: string;
  max: number;
  windowSeconds: number;
}

export const LOGIN_BY_USERNAME: Limit = { name: "login-username", max: 10, windowSeconds: 15 * 60 };
export const LOGIN_BY_IP: Limit = { name: "login-ip", max: 10, windowSeconds: 15 * 60 };
/** The wrong guesses of the current password by someone holding a session of the account. */
export const OWN_PASSWORD_BY_ACCOUNT: Limit = { name: "own-password-account", max: 10, windowSeconds: 15 * 60 };
export const GUEST_TICKET_BY_IP: Limit = { name: "guest-ticket-ip", max: 30, windowSeconds: 60 };

/** An attempt within the limit (`giveBack` uncounts it, for limits that count failures only), or one over it. */
export type Attempt = { ok: true; giveBack(): Promise<void> } | { ok: false; retryAfterSeconds: number };

// Count, and on the first attempt of the window make the key vanish when the window ends.
const COUNT = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;
// Uncount, unless the window is over and its key gone.
const UNCOUNT = `if redis.call('EXISTS', KEYS[1]) == 1 then return redis.call('DECR', KEYS[1]) end
return 0`;

export class RateLimiter {
  constructor(private readonly redis: Redis) {}

  /** Count one attempt against `limit` for `subject` (an IP, a username, an account). */
  async take(limit: Limit, subject: string): Promise<Attempt> {
    const seconds = Math.floor(Date.now() / 1000);
    const window = Math.floor(seconds / limit.windowSeconds);
    const left = (window + 1) * limit.windowSeconds - seconds;
    const key = `rate:${limit.name}:${subject}:${window}`;
    const count = Number(await this.redis.eval(COUNT, 1, key, left));
    if (count > limit.max) return { ok: false, retryAfterSeconds: left };
    return {
      ok: true,
      giveBack: async () => {
        await this.redis.eval(UNCOUNT, 1, key);
      },
    };
  }
}
