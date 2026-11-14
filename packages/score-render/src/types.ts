// What the rest of the app knows about drawing and playing a score. Nothing here names the
// engine behind it (docs/adr/0003): everything is addressed by the ids of the score.
import type { Cursor, ScoreJSON } from "@studio/score-model";

/** A rectangle in CSS pixels, relative to the top-left corner of the element the score is drawn in. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How long each step of the last drawing took, in milliseconds. Diagnostic: the spike reads it. */
export interface RenderTimings {
  /** Building the engine's model from the score (the projection). */
  project: number;
  /** The engine's own pass over that model (links, durations, positions in time). */
  finish: number;
  /** From handing the model to the engine to its layout being ready. */
  render: number;
}

export interface RenderedEvent {
  /** Only the bars from the first changed one were laid out again. */
  partial: boolean;
  timings: RenderTimings;
}

export type Unsubscribe = () => void;

export interface ScoreRenderer {
  /** Draw a score from scratch. `partIds` are the parts to show; left out, all of them. */
  setScore(score: ScoreJSON, partIds?: readonly string[]): void;
  /**
   * Draw the same score again after the content of some bars changed and nothing else did
   * (same bars, same parts, same time signatures). Anything else needs `setScore`.
   */
  patchBars(score: ScoreJSON, barIds: readonly string[]): void;
  /** Change which parts are shown, without changing the score. */
  showParts(partIds: readonly string[]): void;
  /** Where the cursor is on the page, or null when its place is not drawn (yet). */
  boundsOf(cursor: Cursor): Rect | null;
  /**
   * Where playback is on the page at a tick (`ScorePlayer.position`): the beat played then, as
   * tall as its system, so that the page can keep it on screen. At the start of a bar it is
   * where the cursor stands in that bar's empty voice. Null before the sound is made, or when
   * that place is not drawn.
   */
  boundsAtTick(tick: number): Rect | null;
  /** The cursor nearest to a point of the page, or null outside any bar. */
  hitTest(x: number, y: number): Cursor | null;
  /**
   * Areas of the page that no overlay may cover (cursors, name tags, selections, notices...):
   * an overlay that would reach into one moves away from it. Empty before a drawing is laid out.
   */
  reservedRects(): Rect[];
  /** Called every time a drawing is laid out and `boundsOf` answers for it. */
  onRendered(listener: (event: RenderedEvent) => void): Unsubscribe;
  /**
   * Called when a piece of the page has been painted, with the bars it holds. Painting is lazy:
   * only the pieces on screen are painted, each a moment after `onRendered`.
   */
  onPainted(listener: (barIds: string[]) => void): Unsubscribe;
  destroy(): void;
}

/** "loading" until the soundfont and the sound of the score are in place. */
export type PlayerState = "loading" | "paused" | "playing";

export interface PlayerPosition {
  /** 960 ticks in a quarter note, from the start of the score. */
  tick: number;
  endTick: number;
  milliseconds: number;
  endMilliseconds: number;
}

/** A stretch of the score to play, in ticks. */
export interface PlayRange {
  startTick: number;
  endTick: number;
}

/**
 * Playing the score the renderer shows. The mixer settings (mute, solo, volume, speed, loop)
 * belong to the member, not to the score.
 */
export interface ScorePlayer {
  /**
   * Make the sound match the score shown now. While playing, playback goes on from where it
   * was; resolves once the new sound is in place.
   */
  load(): Promise<void>;
  play(): void;
  pause(): void;
  stop(): void;
  readonly state: PlayerState;
  readonly position: PlayerPosition;
  seek(tick: number): void;
  /** The tick a bar starts at, the first time it is played; null before the sound is made. */
  tickOf(barId: string): number | null;
  /** The bar played at a tick; null before the sound is made. */
  barAt(tick: number): string | null;
  setMute(partId: string, mute: boolean): void;
  setSolo(partId: string, solo: boolean): void;
  /** 0 is silent, 1 the volume written in the score. */
  setVolume(partId: string, volume: number): void;
  /** 1 is the tempo of the score. */
  setSpeed(speed: number): void;
  /** Play a range again and again; null plays the whole score once. */
  setLoop(range: PlayRange | null): void;
  onState(listener: (state: PlayerState) => void): Unsubscribe;
  onPosition(listener: (position: PlayerPosition) => void): Unsubscribe;
}
