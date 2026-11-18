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
   * than a value of the document may be). Only on the score page, which has a document; the
   * versions page (#67) shows a version, not one.
   */
  writeMeta?(field: string, json: string): void;
}

declare global {
  interface Window {
    __studioTest?: StudioTestHook;
  }
}

/** The hooks put on, the latest last: the versions page's above the score's, which stays open under it. */
const exposed: StudioTestHook[] = [];

/**
 * Put the hook on `window` for the tests, in an end-to-end build only; returns the function that
 * takes it off. The latest hook put on is the one on `window`; once it is taken off, the one put
 * on before it, still on, is there again (the score's, back from its versions page).
 */
export function exposeForTests(hook: StudioTestHook): () => void {
  if (import.meta.env.VITE_E2E !== "1") return () => {};
  exposed.push(hook);
  window.__studioTest = hook;
  return () => {
    const at = exposed.indexOf(hook);
    if (at !== -1) exposed.splice(at, 1);
    if (window.__studioTest !== hook) return;
    const before = exposed.at(-1);
    if (before === undefined) delete window.__studioTest;
    else window.__studioTest = before;
  };
}
