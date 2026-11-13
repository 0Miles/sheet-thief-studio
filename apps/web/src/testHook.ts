// `window.__studioTest`: what the end-to-end tests read from the page (docs/spec/testing.md,
// section 2). Three read-only functions, only in a build made with VITE_E2E=1: in any other build
// the code below is dead, and the bundle does not even hold the name.
import type { Cursor, Flag, ScoreJSON } from "@studio/score-model";

export interface StudioTestHook {
  /** The open score as plain data; null before one is open. */
  scoreJson(): ScoreJSON | null;
  /** The member's cursor; null where there is none (outside the edit views). */
  cursor(): Cursor | null;
  flags(): Flag[];
}

declare global {
  interface Window {
    __studioTest?: StudioTestHook;
  }
}

/** Put the hook on `window` for the tests, in an end-to-end build only; returns the function that takes it off. */
export function exposeForTests(hook: StudioTestHook): () => void {
  if (import.meta.env.VITE_E2E !== "1") return () => {};
  window.__studioTest = hook;
  return () => {
    if (window.__studioTest === hook) delete window.__studioTest;
  };
}
