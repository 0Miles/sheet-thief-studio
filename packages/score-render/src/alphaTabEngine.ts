// The renderer and the player on alphaTab 1.9: one alphaTab instance draws the score and plays it.
import * as alphaTab from "@coderline/alphatab";
import type { Cursor, PartKind, ScoreJSON, Selection } from "@studio/score-model";

import { cursorAtPoint, cursorRect, type DrawnExtent, noteHeads, type PartShape, playbackRect, reservedRects, selectionRects, type StaffMetrics } from "./geometry";
import { type Projection, projectScore, replaceBars } from "./projection";
import { barAtTick } from "./ticks";
import type { NoteHead, PlayedBar, PlayerPosition, PlayerState, PlayRange, Rect, RenderedEvent, RenderTimings, ScorePlayer, ScoreRenderer, Unsubscribe } from "./types";

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
  /**
   * The scale asked for. alphaTab's own (`settings.display.scale`) is that of the drawing under
   * way, or of the last one: the places on the page are measured with it until the next drawing starts.
   */
  private scale: number;
  /** The drawing alphaTab is working on, and the change that arrived meanwhile. */
  private running: { partial: boolean; timings: RenderTimings; startedAt: number } | null = null;
  private waiting: Request | null = null;
  private rendered = new Listeners<RenderedEvent>();
  private painted = new Listeners<string[]>();
  private states = new Listeners<PlayerState>();
  private positions = new Listeners<PlayerPosition>();
  private finished = new Listeners<void>();
  private playerState: PlayerState = "loading";
  private playerIsReady = false;
  private lastPosition: PlayerPosition = { tick: 0, endTick: 0, milliseconds: 0, endMilliseconds: 0 };
  /**
   * What the member asked for last: to play, or not. alphaTab's own state (`api.playerState`)
   * comes from its worker, after the fact: a pause just asked for is not in it yet.
   */
  private intendsToPlay = false;
  /**
   * Where playback was sent (a seek, a stop, back after a new sound) until alphaTab reports from
   * there; its position (`api.tickPosition`) comes from its worker too.
   */
  private sentTo: { tick: number; at: number } | null = null;
  /**
   * Set while alphaTab makes the sound again (`load()`, or a new model). It stops and goes back
   * to the start meanwhile; once the sound is in place, playback goes back to `currentTick()`,
   * playing if the member wants it to. What it reports meanwhile is not playback. `loads` is how
   * many sounds are being made, each reporting its own `midiLoaded`: the last one counts.
   */
  private reload: { loads: number; done: () => void } | null = null;
  /** The parts shown or the scale changed while a drawing was under way: the whole score is drawn again after it. */
  private layoutChanged = false;
  /** `load()`s asked for while a change waited to be drawn: their sound is made once that is in the model. */
  private loadsAfterDrawing: (() => void)[] = [];
  /** The model changed in place since the sound was made: `load()` has something to do. */
  private soundStale = false;
  private destroyed = false;

  constructor(
    private element: HTMLElement,
    private options: EngineOptions,
  ) {
    this.scale = options.scale ?? 1;
    const settings = new alphaTab.Settings();
    settings.core.fontDirectory = options.fontDirectory;
    settings.core.useWorkers = options.useWorkers ?? true;
    settings.core.includeNoteBounds = true;
    settings.core.enableLazyLoading = true; // partial layout needs it
    settings.display.layoutMode = alphaTab.LayoutMode.Page;
    settings.display.staveProfile = alphaTab.StaveProfile.Default;
    settings.display.scale = this.scale;
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
    // alphaTab makes a new sound in this order, its worker reporting each step: position 0,
    // paused, ready, midiLoaded, ready again, position 0 (alphaTab.core.mjs, `loadMidiFile`).
    api.playerReady.on(() => {
      // Said again after every new sound: only the first time is news.
      if (this.playerIsReady) return;
      this.playerIsReady = true;
      this.setState("paused");
    });
    api.playerStateChanged.on((event) => {
      // Not before the player can play (alphaTab reports "paused" as soon as a listener is
      // added), and not while it stops to take a new sound: that is not the member pausing.
      if (!this.playerIsReady || this.reload) return;
      this.setState(event.state === alphaTab.synth.PlayerState.Playing ? "playing" : "paused");
    });
    api.playerFinished.on(() => {
      // At the end of a loop alphaTab goes back to its start and plays on.
      if (this.reload !== null || api.isLooping) return;
      this.intendsToPlay = false;
      this.finished.emit();
    });
    api.playerPositionChanged.on((event) => {
      // Taking a new sound rewinds alphaTab for a moment: not a position of the playback.
      if (this.reload) return;
      // Nor what it reports from before it went where it was sent (the last position 0 of a new sound).
      if (this.sentTo !== null) {
        if (event.currentTick < this.sentTo.tick && performance.now() - this.sentTo.at < 500) return;
        this.sentTo = null;
      }
      this.lastPosition = { tick: event.currentTick, endTick: event.endTick, milliseconds: event.currentTime, endMilliseconds: event.endTime };
      this.positions.emit(this.lastPosition);
    });
    api.midiLoaded.on(() => this.onSoundSettled());
    // A sound the worker could not take is over too (alphaTab tells the API only as an error):
    // nothing is to wait for it, and playback goes back to where it was.
    api.player?.midiLoadFailed.on(() => this.onSoundSettled());
    // alphaTab seeks on a click only with its own cursor, which is off: the engine does it.
    if (options.seekOnClick) {
      api.beatMouseUp.on((beat) => {
        if (beat) this.seekToBeat(beat);
      });
    }
  }

  // --- ScoreRenderer ---

  setScore(score: ScoreJSON, partIds?: readonly string[]): void {
    if (partIds) this.shown = partIds;
    this.request({ score, barIds: null });
  }

  patchBars(score: ScoreJSON, barIds: readonly string[]): void {
    // Until it is drawn, the sound is not that of the score either.
    this.soundStale = true;
    this.request({ score, barIds: new Set(barIds) });
  }

  showParts(partIds: readonly string[]): void {
    this.shown = partIds;
    this.relayout();
  }

  setScale(scale: number): void {
    if (this.scale === scale) return;
    this.scale = scale;
    this.relayout();
  }

  boundsOf(cursor: Cursor): Rect | null {
    const lookup = this.api.boundsLookup;
    if (lookup === null || this.projection === null) return null;
    const rect = cursorRect(lookup, this.projection, this.parts, cursor, this.metrics());
    return rect && this.fromSurface(rect);
  }

  boundsOfSelection(selection: Selection): Rect[] {
    const lookup = this.api.boundsLookup;
    if (lookup === null || this.projection === null) return [];
    return selectionRects(lookup, this.projection, this.parts, selection, this.metrics()).map((rect) => this.fromSurface(rect));
  }

  noteHeadsOf(cursor: Cursor): NoteHead[] {
    const lookup = this.api.boundsLookup;
    if (lookup === null || this.projection === null) return [];
    return noteHeads(lookup, this.projection, this.parts, cursor).map((head) => ({ ...head, rect: this.fromSurface(head.rect) }));
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
    else if (this.layoutChanged) this.drawAll();
    // Every change asked for is in the model now: the sound asked for meanwhile can be made.
    const loads = this.loadsAfterDrawing;
    if (loads.length === 0) return;
    this.loadsAfterDrawing = [];
    this.makeSound(() => {
      for (const done of loads) done();
    });
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
      // A change waiting for the drawing under way is not in the model yet: the sound is made once it is.
      if (this.waiting !== null) this.loadsAfterDrawing.push(resolve);
      else this.makeSound(resolve);
    });
  }

  /**
   * Make the sound of the model as it is now, unless one is being made of it already; `done` once
   * it is in place, or at once when the sound is that of the model already.
   */
  private makeSound(done: () => void): void {
    if (!this.soundStale && this.reload === null) {
      done();
      return;
    }
    // A new sound under way settles this one too.
    const previous = this.reload;
    this.reload = {
      loads: previous?.loads ?? 0,
      done: () => {
        previous?.done();
        done();
      },
    };
    // A new model's sound is being made already, of the model as it is now.
    if (!this.soundStale) return;
    this.soundStale = false;
    this.reload.loads += 1;
    this.api.loadMidiForScore();
  }

  play(): void {
    this.intendsToPlay = true;
    // While a new sound is made, it plays once that is in place.
    if (this.reload === null) this.api.play();
  }

  pause(): void {
    this.intendsToPlay = false;
    this.api.pause();
    // alphaTab has stopped to take the new sound, and reports nothing of the member's pause.
    if (this.reload) this.setState("paused");
  }

  stop(): void {
    this.intendsToPlay = false;
    this.sentTo = { tick: 0, at: performance.now() };
    this.api.stop();
    if (this.reload) this.setState("paused");
  }

  get state(): PlayerState {
    return this.playerState;
  }

  get position(): PlayerPosition {
    return this.lastPosition;
  }

  seek(tick: number): void {
    // While a new sound is made, alphaTab goes back to the start after this: it comes back here then.
    this.sentTo = { tick, at: performance.now() };
    this.api.tickPosition = tick;
  }

  /** Send playback to where a beat starts, the first time its bar is played (as alphaTab's own seek on a click). */
  private seekToBeat(beat: alphaTab.model.Beat): void {
    const cache = this.api.tickCache;
    if (cache === null) return;
    const tick = cache.getMasterBarStart(beat.voice.bar.masterBar) + (cache.getRelativeBeatPlaybackRange(beat)?.startTick ?? beat.playbackStart);
    // Within the loop, when there is one: a click outside it goes to its nearer end.
    const range = this.api.playbackRange;
    this.seek(range ? Math.min(Math.max(tick, range.startTick), range.endTick) : tick);
  }

  tickOf(barId: string): number | null {
    const index = this.projection?.barIndex.get(barId);
    const masterBar = index === undefined ? undefined : this.projection?.score.masterBars[index];
    // alphaTab makes the tick lookup of a new model as it gets the model, before the sound.
    const cache = this.api.tickCache;
    return masterBar === undefined || cache === null ? null : cache.getMasterBarStart(masterBar);
  }

  barAt(tick: number): PlayedBar | null {
    const cache = this.api.tickCache;
    const played = cache && barAtTick(cache, tick);
    const barId = played && this.projection?.barIds[played.index];
    return played && barId ? { barId, index: played.index } : null;
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

  onFinished(listener: () => void): Unsubscribe {
    return this.finished.add(listener);
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
    // Only the changed bars are rebuilt, inside the model alphaTab already has; alphaTab is told
    // which bar changed first, so that it keeps the systems before it (docs/adr/0003).
    if (previous && barIds && barIds.size > 0) firstChanged = replaceBars(previous, score, [...barIds], settings, projectionTimings);
    if (firstChanged === null) this.projection = projectScore(score, settings, projectionTimings);
    const projection = this.projection as Projection;
    const partial = firstChanged !== null && !this.layoutChanged;
    const hints = partial ? { firstChangedMasterBar: firstChanged as number, reuseViewport: true } : firstChanged !== null ? { reuseViewport: true } : undefined;
    this.running = {
      partial,
      timings: { project: projectionTimings.build, finish: projectionTimings.finish, render: 0 },
      startedAt: performance.now(),
    };
    this.applyScale();
    if (projection.score === this.api.score) {
      this.soundStale = true;
      // Other parts shown, or another scale, since the last drawing: nothing laid out before holds.
      if (this.layoutChanged) this.drawAll();
      else this.api.render(hints);
      return;
    }
    this.layoutChanged = false;
    // alphaTab makes the sound of a score it has not seen and, doing so, stops playback and goes
    // back to the start, playing or paused: playback goes on from where it was.
    this.soundStale = false;
    if (this.playerIsReady && this.options.soundFont !== null) {
      this.reload ??= { loads: 0, done: () => {} };
      this.reload.loads += 1;
    }
    this.api.renderScore(projection.score, this.trackIndexes(projection), hints);
  }

  /** Draw the score again as it is, with the parts shown and at the scale asked for now; once alphaTab is free. */
  private relayout(): void {
    // Not drawn yet: the first drawing uses them.
    if (this.projection === null) return;
    if (this.running) this.layoutChanged = true;
    else this.drawAll();
  }

  private drawAll(): void {
    const projection = this.projection as Projection;
    this.layoutChanged = false;
    this.running ??= { partial: false, timings: { ...NO_TIMINGS }, startedAt: performance.now() };
    this.applyScale();
    this.api.renderTracks(this.trackIndexes(projection).map((index) => projection.score.tracks[index] as alphaTab.model.Track));
  }

  /** A drawing starts: at the scale asked for last. */
  private applyScale(): void {
    const display = this.api.settings.display;
    if (display.scale === this.scale) return;
    display.scale = this.scale;
    this.api.updateSettings();
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

  /** Where playback is, as the engine knows it: where it was sent, until alphaTab reports from there. */
  private currentTick(): number {
    return this.sentTo?.tick ?? this.lastPosition.tick;
  }

  /**
   * A new sound is in place, or the worker could not take it: alphaTab stopped and rewound either
   * way, so go back to where playback was.
   */
  private onSoundSettled(): void {
    const reload = this.reload;
    if (reload === null || --reload.loads > 0) return;
    this.reload = null;
    this.seek(this.currentTick());
    if (this.intendsToPlay) this.api.play();
    // A pause asked for while the sound was made: alphaTab reported nothing of it.
    else this.setState("paused");
    reload.done();
  }
}

export function createAlphaTabEngine(element: HTMLElement, options: EngineOptions): ScoreEngine {
  const engine = new AlphaTabEngine(element, options);
  return { renderer: engine, player: engine, destroy: () => engine.destroy() };
}
