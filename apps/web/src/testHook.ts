// `window.__studioTest`: what the end-to-end tests read from the page (docs/spec/testing.md,
// section 2). Read-only functions but one, `writeMeta`, only in a build made with VITE_E2E=1: in
// any other build the code below is dead, and the bundle does not even hold the name.
import type { Cursor, Flag, ScoreJSON } from "@studio/score-model";
import type { PlayerSettings } from "@studio/score-render";

export interface StudioTestHook {
  /** The open score as plain data; null before one is open. */
  scoreJson(): ScoreJSON | null;
  /** The member's cursor; null where there is none (outside the edit views). */
  cursor(): Cursor | null;
  flags(): Flag[];
  /** The settings the player plays with (#33); null before there is one. */
  player(): PlayerSettings | null;
  /**
   * Write a value straight into the page's document, past the commands, as an older tab or data
   * kept offline may hold it (#102): `json` parsed, as the field `field` of the meta. The only
   * write of the hook: no command or key writes what a test needs here (a value nested deeper
   * than a value of the document may be).
   */
  writeMeta(field: string, json: string): void;
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
