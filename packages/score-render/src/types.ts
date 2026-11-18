// What the rest of the app knows about drawing and playing a score. Nothing here names the
// engine behind it (docs/adr/0003): everything is addressed by the ids of the score.
import type { Cursor, ScoreJSON, Selection } from "@studio/score-model";

import type { PartMix } from "./channels";

/** A rectangle in CSS pixels, relative to the top-left corner of the element the score is drawn in. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How long each step of the last drawing took, in milliseconds. Diagnostic: the measurements read it. */
export interface RenderTimings {
  /** Building the engine's model from the score (the projection). */
  project: number;
  /** The engine's own pass over that model (links, durations, positions in time). */
  finish: number;
  /** From handing the model to the engine to its layout being ready. */
  render: number;
}

/** A note head as the engine drew it (a fret number, in tablature), under the key the score gives its note ("s2", "p38", "n61"). */
export interface NoteHead {
  key: string;
  rect: Rect;
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
  /** Draw the score bigger or smaller: 1 is its own size. */
  setScale(scale: number): void;
  /** Where the cursor is on the page, or null when its place is not drawn (yet). */
  boundsOf(cursor: Cursor): Rect | null;
  /**
   * Where a selection is on the page: one rectangle for a beat range, one for each system a bar
   * range is on. None when its place is not drawn (yet).
   */
  boundsOfSelection(selection: Selection): Rect[];
  /**
   * Where the bars a structural command works on are drawn, from one to the other: a box for each
   * system they are on, over every part shown (docs/spec/commands.md, section 6). None when they
   * are not drawn (yet).
   */
  boundsOfBars(anchorBarId: string, focusBarId: string): Rect[];
  /**
   * Where the note heads of the cursor's beat are drawn, as the engine reports them; none in an
   * append slot, or when the beat is not drawn. Diagnostic: the measurements compare them with
   * `boundsOf`.
   */
  noteHeadsOf(cursor: Cursor): NoteHead[];
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
  /**
   * What the engine needs to draw could not be had: the music font, or the worker that lays out
   * the score (#151). Nothing is drawn until `retry()` has them; the engine retries by itself once
   * the browser is back online.
   */
  readonly failed: boolean;
  /** Called when `failed` changes: true when it fails, false when it is asked for again. */
  onFailed(listener: (failed: boolean) => void): Unsubscribe;
  /**
   * When `failed`: download what could not be had again, and draw the score asked for last from
   * scratch. The player starts over too ("loading"). Otherwise nothing.
   */
  retry(): void;
  destroy(): void;
}

/**
 * "loading" until the soundfont and the sound of the score are in place. "failed" when the
 * soundfont, or the worker that makes the sound (#151), could not be had (the network went, the
 * server refused it): `retry()` asks for it again, as the player does itself once the browser is
 * back online, "loading" meanwhile.
 * "unavailable" from the start, and for good, in a browser that cannot play (no Web Audio):
 * nothing plays, the score is still drawn (docs/spec/playback.md, 4.1).
 */
export type PlayerState = "loading" | "paused" | "playing" | "failed" | "unavailable";

/** A bar as playback finds it: its id, and its index in the score as the sound has it. */
export interface PlayedBar {
  barId: string;
  index: number;
}

export interface PlayerPosition {
  /** 960 ticks in a quarter note, from the start of the score. */
  tick: number;
  endTick: number;
  milliseconds: number;
  endMilliseconds: number;
}

/** What `ScorePlayer.settings` tells: the mix by part id, of the parts given one only. */
export interface PlayerSettings {
  speed: number;
  metronome: boolean;
  countIn: boolean;
  loop: PlayRange | null;
  parts: Record<string, PartMix>;
}

/** A stretch of the score to play, in ticks. */
export interface PlayRange {
  startTick: number;
  endTick: number;
}

/**
 * Playing the score the renderer shows. The mixer settings (mute, solo, volume, speed, loop,
 * metronome, count-in) belong to the member, not to the score (docs/spec/playback.md, section 1):
 * the player keeps them, by part id, through every new sound until they are changed.
 */
export interface ScorePlayer {
  /**
   * Make the sound match the score shown now. While playing, playback goes on from where it
   * was; resolves once the new sound is in place.
   */
  load(): Promise<void>;
  /**
   * The soundfont or the worker that makes the sound could not be had ("failed"): ask for it
   * again, "loading" meanwhile. A worker is had again with the score drawn anew, as
   * `ScoreRenderer.retry()` does. Otherwise nothing.
   */
  retry(): void;
  play(): void;
  pause(): void;
  stop(): void;
  readonly state: PlayerState;
  readonly position: PlayerPosition;
  seek(tick: number): void;
  /** The tick a bar starts at, the first time it is played; null for a bar not in the score drawn. */
  tickOf(barId: string): number | null;
  /** The bar played at a tick; null before the sound is made. */
  barAt(tick: number): PlayedBar | null;
  /**
   * The ticks a selection is played over, the first time it is: from the start of its first beat
   * to the end of its last, or from the start of its first bar to the end of its last
   * (docs/spec/playback.md, section 4). Null before the sound is made, or for what is not in the
   * score drawn.
   */
  loopOf(selection: Selection): PlayRange | null;
  /**
   * Parts sharing a MIDI channel (drums with drums, parts past the limit) cannot be told apart:
   * the channel is muted when any of them is, played alone when any of them is, and as loud as the
   * quietest of them.
   */
  setMute(partId: string, mute: boolean): void;
  setSolo(partId: string, solo: boolean): void;
  /** 0 is silent, 1 the volume written in the score. */
  setVolume(partId: string, volume: number): void;
  /** 1 is the tempo of the score. */
  setSpeed(speed: number): void;
  /**
   * Play a range again and again; null plays the whole score once. Playback inside the new range
   * stays where it is; outside it, it goes to the nearer end.
   */
  setLoop(range: PlayRange | null): void;
  /** A click on every beat while playing; off at first. */
  setMetronome(on: boolean): void;
  /** One bar of clicks before playing starts; off at first. */
  setCountIn(on: boolean): void;
  /** The settings it plays with now, as the engine holds them. Diagnostic: the e2e tests read it. */
  settings(): PlayerSettings;
  onState(listener: (state: PlayerState) => void): Unsubscribe;
  onPosition(listener: (position: PlayerPosition) => void): Unsubscribe;
  /** Called when playback reaches the end of the score and stops there; not at the end of a loop. */
  onFinished(listener: () => void): Unsubscribe;
}
