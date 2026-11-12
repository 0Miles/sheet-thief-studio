// What the spike page exposes on `window.__studio` for the Playwright tests and measurements.
// M0 only.
import type { Cursor, ScoreJSON } from "@studio/score-model";
import type { PlayerPosition, PlayerState, Rect, RenderTimings } from "@studio/score-render";

/** One drawing of the score after a change, in milliseconds. */
export interface RenderSample extends RenderTimings {
  /** Reading the document into plain data (`docToJson`). */
  toJson: number;
  partial: boolean;
  /** From the change to the layout being ready (`onRendered`). */
  total: number;
}

/** One key press, as times from `performance.now()`. */
export interface KeySample {
  key: string;
  /** When the browser made the event. */
  pressed: number;
  /** When the page began to handle it. */
  started: number;
  /** When the command had run and the cursor was drawn again. */
  handled: number;
  /** When the layout of the changed score was ready; null for a key that changes nothing. */
  rendered: number | null;
  /** When the piece of the page holding the cursor's bar was painted again; null as above. */
  painted: number | null;
  /** The first animation frame after all of the above. */
  frame: number;
  /** The frame after that one: by then the first has been shown. */
  nextFrame: number;
}

export interface StudioHook {
  /** The score is drawn and the cursor placed. */
  ready: boolean;
  /** Every change made here has reached the server (always true for a score that is not co-edited). */
  synced(): boolean;
  json(): ScoreJSON;
  /** Size in bytes of the whole Yjs state of the document. */
  stateSize(): number;
  cursor(): Cursor | null;
  cursorRect(): Rect | null;
  /** Put the cursor on a beat (or before the first, with -1) of a bar of a part, all by index. */
  placeCursor(part: number, bar: number, beat: number, line: number): Cursor | null;
  /** Change one fret in a bar of a part (by index) as a member would, and wait for the drawing. */
  editBar(part: number, bar: number): Promise<RenderSample>;
  /** Apply `count` edits spread over the score without drawing, for the size of the document. */
  bulkEdit(count: number): void;
  renders: RenderSample[];
  keys: KeySample[];
  player: {
    state(): PlayerState;
    position(): PlayerPosition;
    play(): void;
    pause(): void;
    /**
     * Regenerate the sound. Resolves with how long the page was busy making it (`generate`)
     * and how long until the player had taken it (`total`), in milliseconds.
     */
    reload(): Promise<{ generate: number; total: number }>;
    /** Every position the player reported, with when (`performance.now()`). */
    trace: { at: number; tick: number; state: PlayerState }[];
  };
  errors: string[];
}

declare global {
  interface Window {
    __studio?: StudioHook;
  }
}
