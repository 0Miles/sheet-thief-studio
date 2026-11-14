// The renderer and the player on alphaTab 1.9: one alphaTab instance draws the score and plays it.
import * as alphaTab from "@coderline/alphatab";
import type { Cursor, PartKind, ScoreJSON } from "@studio/score-model";

import { cursorAtPoint, cursorRect, type DrawnExtent, type PartShape, playbackRect, reservedRects, type StaffMetrics } from "./geometry";
import { type Projection, projectScore, replaceBars } from "./projection";
import { barAtTick, barStartTick } from "./ticks";
import type { PlayerPosition, PlayerState, PlayRange, Rect, RenderedEvent, RenderTimings, ScorePlayer, ScoreRenderer, Unsubscribe } from "./types";

export interface EngineOptions {
  /** Where the music font is served from, with a trailing slash. */
  fontDirectory: string;
  /** The soundfont to play with; null leaves the player out (the score is only drawn). */
  soundFont: string | null;
  /** The element that scrolls the score, when it is not the page. */
  scrollElement?: HTMLElement;
  /**
   * A click on the score moves playback there (the Read view). Off, the default, a click is the
   * page's alone: in the edit views it only moves the cursor (docs/spec/views.md, section 2).
   */
  seekOnClick?: boolean;
  /** Lay out and draw in a web worker (the default) or on the page's own thread. */
  useWorkers?: boolean;
  /**
   * How `patchBars` brings the changed bars to alphaTab: "replace" rebuilds only those bars
   * inside the model alphaTab already has; "project" builds the whole model again.
   */
  patch?: "replace" | "project";
  /** Tell alphaTab which bar changed first, so that it keeps the systems before it. */
  partialLayout?: boolean;
  /**
   * Draw only this many bars around the last changed one instead of the whole score. Spike
   * only (the fallback of question S2): the bars outside the window are not on the page.
   */
  windowBars?: number;
  scale?: number;
}

export interface ScoreEngine {
  renderer: ScoreRenderer;
  player: ScorePlayer;
  destroy(): void;
}

interface Request {
  score: ScoreJSON;
  /** Bars whose content changed; null draws from scratch. */
  barIds: Set<string> | null;
}

class Listeners<T> {
  private items = new Set<(value: T) => void>();

  add(listener: (value: T) => void): Unsubscribe {
    this.items.add(listener);
    return () => this.items.delete(listener);
  }

  emit(value: T): void {
    for (const listener of this.items) listener(value);
  }
}

const NO_TIMINGS: RenderTimings = { project: 0, finish: 0, render: 0 };

class AlphaTabEngine implements ScoreRenderer, ScorePlayer {
  private api: alphaTab.AlphaTabApi;
  private projection: Projection | null = null;
  private parts = new Map<string, PartShape>();
  /** Parts to show; null shows all of them. */
  private shown: readonly string[] | null = null;
  /** The drawing alphaTab is working on, and the change that arrived meanwhile. */
  private running: { partial: boolean; timings: RenderTimings; startedAt: number } | null = null;
  private waiting: Request | null = null;
  private rendered = new Listeners<RenderedEvent>();
  private painted = new Listeners<string[]>();
  private states = new Listeners<PlayerState>();
  private positions = new Listeners<PlayerPosition>();
  private playerState: PlayerState = "loading";
  private playerIsReady = false;
  private lastPosition: PlayerPosition = { tick: 0, endTick: 0, milliseconds: 0, endMilliseconds: 0 };
  /** Set while `load()` waits for alphaTab to take the new sound. */
  private reload: { resume: boolean; tick: number; done: () => void } | null = null;
  /** Where playback was sent back to after a reload, until alphaTab reports from there. */
  private resumedAt: { tick: number; at: number } | null = null;
  private destroyed = false;

  constructor(
    private element: HTMLElement,
    private options: EngineOptions,
  ) {
    const settings = new alphaTab.Settings();
    settings.core.fontDirectory = options.fontDirectory;
    settings.core.useWorkers = options.useWorkers ?? true;
    settings.core.includeNoteBounds = true;
    settings.core.enableLazyLoading = true; // partial layout needs it
    settings.display.layoutMode = alphaTab.LayoutMode.Page;
    settings.display.staveProfile = alphaTab.StaveProfile.Default;
    settings.display.scale = options.scale ?? 1;
    settings.notation.rhythmMode = alphaTab.TabRhythmMode.ShowWithBars;
    if (options.soundFont === null) {
      settings.player.playerMode = alphaTab.PlayerMode.Disabled;
    } else {
      settings.player.playerMode = alphaTab.PlayerMode.EnabledSynthesizer;
      settings.player.soundFont = options.soundFont;
      settings.player.scrollMode = alphaTab.ScrollMode.Off; // the page decides what scrolls
      // The page draws where playback is (`boundsAtTick`), clear of the reserved areas.
      settings.player.enableCursor = false;
      settings.player.enableSeekToClick = options.seekOnClick ?? false;
      // A loop comes from the member's selection, never from dragging over the score.
      settings.player.enablePlaybackRangeSelection = false;
      if (options.scrollElement) settings.player.scrollElement = options.scrollElement;
    }
    this.api = new alphaTab.AlphaTabApi(element, settings);
    const api = this.api;
    // Every listener is added once, here: alphaTab calls a new listener of some events at once
    // with the last value (midiLoaded), so adding one later from inside a handler would loop.
    api.postRenderFinished.on(() => this.handleRendered());
    api.renderer.partialRenderFinished.on((piece) => {
      const barIds = this.projection?.barIds.slice(Math.max(piece.firstMasterBarIndex, 0), piece.lastMasterBarIndex + 1) ?? [];
      this.painted.emit(barIds);
    });
    api.error.on((error) => console.error("[score-render]", error));
    api.playerReady.on(() => {
      this.playerIsReady = true;
      if (this.reload === null) this.setState(api.playerState === alphaTab.synth.PlayerState.Playing ? "playing" : "paused");
    });
    api.playerStateChanged.on((event) => {
      // Not before the player can play (alphaTab reports "paused" as soon as a listener is
      // added), and not while it stops to take a new sound: that is not the member pausing.
      if (!this.playerIsReady || this.reload) return;
      this.setState(event.state === alphaTab.synth.PlayerState.Playing ? "playing" : "paused");
    });
    api.playerPositionChanged.on((event) => {
      // Taking a new sound rewinds alphaTab for a moment: not a position of the playback.
      if (this.reload) return;
      if (this.resumedAt !== null) {
        if (event.currentTick < this.resumedAt.tick && performance.now() - this.resumedAt.at < 500) return;
        this.resumedAt = null;
      }
      this.lastPosition = { tick: event.currentTick, endTick: event.endTick, milliseconds: event.currentTime, endMilliseconds: event.endTime };
      this.positions.emit(this.lastPosition);
    });
    api.midiLoaded.on(() => this.onMidiLoaded());
  }

  // --- ScoreRenderer ---

  setScore(score: ScoreJSON, partIds?: readonly string[]): void {
    if (partIds) this.shown = partIds;
    this.request({ score, barIds: null });
  }

  patchBars(score: ScoreJSON, barIds: readonly string[]): void {
    this.request({ score, barIds: new Set(barIds) });
  }

  showParts(partIds: readonly string[]): void {
    this.shown = partIds;
    const projection = this.projection;
    if (projection === null || this.running) return; // the drawing under way or to come uses it
    this.running = { partial: false, timings: { ...NO_TIMINGS }, startedAt: performance.now() };
    this.api.renderTracks(this.trackIndexes(projection).map((index) => projection.score.tracks[index] as alphaTab.model.Track));
  }

  boundsOf(cursor: Cursor): Rect | null {
    const lookup = this.api.boundsLookup;
    if (lookup === null || this.projection === null) return null;
    const rect = cursorRect(lookup, this.projection, this.parts, cursor, this.metrics());
    return rect && this.fromSurface(rect);
  }

  boundsAtTick(tick: number): Rect | null {
    const lookup = this.api.boundsLookup;
    const cache = this.api.tickCache;
    if (lookup === null || cache === null) return null;
    // The bar from the sound (repeats), the beat from the drawing: a bar changed since the sound
    // was made has new beats, already drawn.
    const played = barAtTick(cache, tick);
    const rect = played && playbackRect(lookup, played.index, played.offset);
    return rect && this.fromSurface(rect);
  }

  hitTest(x: number, y: number): Cursor | null {
    const lookup = this.api.boundsLookup;
    if (lookup === null || this.projection === null) return null;
    const origin = this.surfaceOrigin();
    return cursorAtPoint(lookup, this.projection, this.parts, x - origin.x, y - origin.y, this.metrics());
  }

  reservedRects(): Rect[] {
    const lookup = this.api.boundsLookup;
    const projection = this.projection;
    if (lookup === null || projection === null) return [];
    const drawn: DrawnExtent = { barCount: projection.barIds.length, trackCount: this.trackIndexes(projection).length };
    return reservedRects(lookup, drawn, this.api.settings.display.scale).map((rect) => this.fromSurface(rect));
  }

  onRendered(listener: (event: RenderedEvent) => void): Unsubscribe {
    return this.rendered.add(listener);
  }

  onPainted(listener: (barIds: string[]) => void): Unsubscribe {
    return this.painted.add(listener);
  }

  private handleRendered(): void {
    const running = this.running;
    this.running = null;
    const timings = running ? { ...running.timings, render: performance.now() - running.startedAt } : { ...NO_TIMINGS };
    this.rendered.emit({ partial: running?.partial ?? false, timings });
    const waiting = this.waiting;
    this.waiting = null;
    if (waiting) this.run(waiting);
  }

  destroy(): void {
    this.destroyed = true;
    this.api.destroy();
  }

  // --- ScorePlayer ---

  load(): Promise<void> {
    // Before the player is ready alphaTab makes the sound itself, once it is.
    if (this.options.soundFont === null || this.api.score === null || !this.playerIsReady) return Promise.resolve();
    return new Promise((resolve) => {
      // A reload still waiting is replaced: its promise settles with this one.
      const previous = this.reload;
      const resume = previous?.resume ?? this.api.playerState === alphaTab.synth.PlayerState.Playing;
      const tick = previous?.tick ?? this.api.tickPosition;
      this.reload = {
        resume,
        tick,
        done: () => {
          previous?.done();
          resolve();
        },
      };
      this.api.loadMidiForScore();
    });
  }

  play(): void {
    this.api.play();
  }

  pause(): void {
    this.api.pause();
  }

  stop(): void {
    this.api.stop();
  }

  get state(): PlayerState {
    return this.playerState;
  }

  get position(): PlayerPosition {
    return this.lastPosition;
  }

  seek(tick: number): void {
    this.api.tickPosition = tick;
  }

  tickOf(barId: string): number | null {
    const index = this.projection?.barIndex.get(barId);
    const cache = this.api.tickCache;
    return index === undefined || cache === null ? null : barStartTick(cache, index);
  }

  barAt(tick: number): string | null {
    const cache = this.api.tickCache;
    const played = cache && barAtTick(cache, tick);
    return (played && this.projection?.barIds[played.index]) ?? null;
  }

  setMute(partId: string, mute: boolean): void {
    const track = this.trackOf(partId);
    if (track) this.api.changeTrackMute([track], mute);
  }

  setSolo(partId: string, solo: boolean): void {
    const track = this.trackOf(partId);
    if (track) this.api.changeTrackSolo([track], solo);
  }

  setVolume(partId: string, volume: number): void {
    const track = this.trackOf(partId);
    if (track) this.api.changeTrackVolume([track], volume);
  }

  setSpeed(speed: number): void {
    this.api.playbackSpeed = speed;
  }

  setLoop(range: PlayRange | null): void {
    if (range === null) {
      this.api.playbackRange = null;
      this.api.isLooping = false;
      return;
    }
    const playbackRange = new alphaTab.synth.PlaybackRange();
    playbackRange.startTick = range.startTick;
    playbackRange.endTick = range.endTick;
    this.api.playbackRange = playbackRange;
    this.api.isLooping = true;
  }

  onState(listener: (state: PlayerState) => void): Unsubscribe {
    return this.states.add(listener);
  }

  onPosition(listener: (position: PlayerPosition) => void): Unsubscribe {
    return this.positions.add(listener);
  }

  // --- internals ---

  /** One drawing at a time: changes arriving while alphaTab works are merged and drawn after it. */
  private request(request: Request): void {
    if (this.destroyed) return;
    if (this.running === null) {
      this.run(request);
      return;
    }
    const waiting = this.waiting;
    const barIds = waiting && waiting.barIds && request.barIds ? new Set([...waiting.barIds, ...request.barIds]) : waiting ? null : request.barIds;
    this.waiting = { score: request.score, barIds };
  }

  private run({ score, barIds }: Request): void {
    this.parts = new Map(score.parts.map((part) => [part.id, { kind: part.kind as PartKind, strings: part.tuning.length }]));
    const settings = this.api.settings;
    const projectionTimings = { build: 0, finish: 0 };
    const previous = this.projection;
    let firstChanged: number | null = null;
    if (previous && barIds && barIds.size > 0) {
      if ((this.options.patch ?? "replace") === "replace") {
        firstChanged = replaceBars(previous, score, [...barIds], settings, projectionTimings);
      } else if (score.bars.length === previous.barIds.length && score.parts.length === previous.partIds.length) {
        this.projection = projectScore(score, settings, projectionTimings);
        firstChanged = Math.min(...[...barIds].map((id) => this.projection?.barIndex.get(id) ?? 0));
      }
    }
    if (firstChanged === null) this.projection = projectScore(score, settings, projectionTimings);
    const projection = this.projection as Projection;
    const sameWindow = this.moveWindow(firstChanged ?? 0, projection.barIds.length);
    const partial = firstChanged !== null && sameWindow && (this.options.partialLayout ?? true);
    const hints = partial ? { firstChangedMasterBar: firstChanged as number, reuseViewport: true } : firstChanged !== null ? { reuseViewport: true } : undefined;
    this.running = {
      partial,
      timings: { project: projectionTimings.build, finish: projectionTimings.finish, render: 0 },
      startedAt: performance.now(),
    };
    if (projection.score === this.api.score) {
      this.api.render(hints);
      return;
    }
    // alphaTab makes the sound of a score it has not seen and, doing so, stops playback.
    if (this.api.playerState === alphaTab.synth.PlayerState.Playing) this.reload ??= { resume: true, tick: this.api.tickPosition, done: () => {} };
    this.api.renderScore(projection.score, this.trackIndexes(projection), hints);
  }

  /**
   * Keep the drawn window of bars around a changed bar. Returns false when the window moved:
   * what was laid out before is then of no use.
   */
  private moveWindow(changed: number, barCount: number): boolean {
    const size = this.options.windowBars;
    if (size === undefined) return true;
    const display = this.api.settings.display;
    // Windows start every half window, so that typing along a line does not move it at every bar.
    const half = Math.max(Math.floor(size / 2), 1);
    const start = Math.min(Math.max(Math.floor(changed / half) * half - half / 2, 0), Math.max(barCount - size, 0));
    const startBar = Math.floor(start) + 1;
    if (display.startBar === startBar && display.barCount === size) return true;
    display.startBar = startBar;
    display.barCount = size;
    this.api.updateSettings();
    return false;
  }

  private metrics(): StaffMetrics {
    const display = this.api.settings.display;
    const engraving = display.resources.engravingSettings;
    return {
      staffSpace: engraving.oneStaffSpace * display.scale,
      tabLineSpacing: engraving.tabLineSpacing * display.scale,
      lineThickness: engraving.staffLineThickness * display.scale,
    };
  }

  private trackIndexes(projection: Projection): number[] {
    const shown = this.shown ?? projection.partIds;
    const indexes = shown.map((id) => projection.partIndex.get(id)).filter((index): index is number => index !== undefined);
    return indexes.length > 0 ? indexes.sort((a, b) => a - b) : projection.partIds.map((_, index) => index);
  }

  private trackOf(partId: string): alphaTab.model.Track | undefined {
    const index = this.projection?.partIndex.get(partId);
    return index === undefined ? undefined : this.projection?.score.tracks[index];
  }

  /** alphaTab draws into a child of the element; its coordinates start at that child's corner. */
  private surfaceOrigin(): { x: number; y: number } {
    const surface = this.element.querySelector(".at-surface");
    if (surface === null) return { x: 0, y: 0 };
    const outer = this.element.getBoundingClientRect();
    const inner = surface.getBoundingClientRect();
    return { x: inner.left - outer.left, y: inner.top - outer.top };
  }

  private fromSurface(rect: Rect): Rect {
    const origin = this.surfaceOrigin();
    return { ...rect, x: rect.x + origin.x, y: rect.y + origin.y };
  }

  private setState(state: PlayerState): void {
    if (state === this.playerState) return;
    this.playerState = state;
    this.states.emit(state);
  }

  /** alphaTab stops and rewinds when it takes a new sound: go back to where playback was. */
  private onMidiLoaded(): void {
    const reload = this.reload;
    if (reload === null) return;
    this.reload = null;
    if (reload.resume || reload.tick > 0) this.resumedAt = { tick: reload.tick, at: performance.now() };
    if (reload.resume) {
      this.api.tickPosition = reload.tick;
      this.api.play();
    } else if (reload.tick > 0) {
      this.api.tickPosition = reload.tick;
    }
    reload.done();
  }
}

export function createAlphaTabEngine(element: HTMLElement, options: EngineOptions): ScoreEngine {
  const engine = new AlphaTabEngine(element, options);
  return { renderer: engine, player: engine, destroy: () => engine.destroy() };
}
