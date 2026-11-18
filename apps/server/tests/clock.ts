// The process clock in the tests of rate limits. Kept apart from support.ts, which the end-to-end
// scripts import outside vitest.
import { onTestFinished, vi } from "vitest";

/**
 * Hold the process clock still until the test ends (timers keep running), so that every attempt
 * the test makes falls in one window of the fixed-window rate limits (src/rateLimit.ts). On a
 * clock that runs, attempts that straddle the end of a window are counted in two windows, and
 * the one over the limit is let through.
 */
export function holdClock(): void {
  vi.useFakeTimers({ toFake: ["Date"] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}
