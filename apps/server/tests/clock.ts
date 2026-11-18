// The process clock in the tests of rate limits. Kept apart from support.ts, which the end-to-end
// scripts import outside vitest.
import { onTestFinished, vi } from "vitest";

/** A whole number of every window the rate limits use (1 and 15 minutes; src/rateLimit.ts). */
const EVERY_WINDOW_MS = 15 * 60 * 1000;

/**
 * Hold the process clock still until the test ends (timers keep running), at the start of a
 * window of the fixed-window rate limits (src/rateLimit.ts), so that every attempt the test makes
 * falls in that one window and its count lasts the whole window. On a clock that runs, attempts
 * that straddle the end of a window are counted in two windows. A clock merely held still near
 * the end of one is not enough either: the counter's key is given the seconds left in the window
 * as its Redis TTL, which Redis counts down in real time, so with one second left the count starts
 * over a second later. Either way the attempt over the limit is let through.
 *
 * While the clock is held, a helper that waits with `while (Date.now() < until)` (as links.test.ts's
 * `theScoreRowIsAwaited`) never ends: do not use one in such a test.
 */
export function holdClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Math.floor(Date.now() / EVERY_WINDOW_MS) * EVERY_WINDOW_MS);
  onTestFinished(() => {
    vi.useRealTimers();
  });
}
