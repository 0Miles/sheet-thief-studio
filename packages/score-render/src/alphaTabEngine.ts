// The renderer and the player on alphaTab 1.9: one alphaTab instance draws the score and plays it.
import * as alphaTab from "@coderline/alphatab";
import type { Cursor, PartKind, ScoreJSON, Selection } from "@studio/score-model";

import { channelMixOf, NEUTRAL_MIX, type PartMix } from "./channels";
import { barRangeRects, cursorAtPoint, cursorRect, type DrawnExtent, noteHeads, type PartShape, playbackRect, reservedRects, selectionRects, type StaffMetrics } from "./geometry";
import { beatOf, type Projection, projectScore, replaceBars } from "./projection";
import { barAtTick, placeAtTick, tickAtPlace } from "./ticks";
import type { NoteHead, PlayedBar, PlayerPosition, PlayerSettings, PlayerState, PlayRange, Rect, RenderedEvent, RenderTimings, ScorePlayer, ScoreRenderer, Unsubscribe } from "./types";

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

/**
 * Whether alphaTab 1.9 can make its player in this browser, by the checks it makes itself
 * (`BrowserUiFacade.createWorkerPlayer`, and the audio context of its outputs): a worker to make
 * the sound in, an audio context, and a script processor, or audio worklets on a secure page (the
 * engine leaves `player.outputMode` at its default, worklets). Without them alphaTab only logs an
 * error, and its player never gets ready: Playwright's WebKit for Windows has no Web Audio (#129).
 */
function canPlaySound(): boolean {
  const scope = globalThis as unknown as Record<string, unknown>;
  const has = (name: string) => scope[name] != null;
  const context = has("AudioContext") || has("webkitAudioContext");
  const output = has("ScriptProcessorNode") || (scope.isSecureContext === true && has("AudioWorkletNode"));
  return has("Worker") && context && output;
}

/** A place in the music by bar id (`placeAtTick`), and the tick lookup it was found in. */
interface Place {
  barId: string;
  pass: number;
  offset: number;
  cache: alphaTab.midi.MidiTickLookup;
}

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
  /**
   * The member's mix, by part id: alphaTab's own is by MIDI channel, and the channels of the parts
   * move when parts are added, deleted or moved (`channelsOf`). It is given to alphaTab anew with
   * every new sound (`applyMix`).
   */
  private mix = new Map<string, PartMix>();
  /** The range played again and again; alphaTab forgets it with every new sound. */
  private loop: PlayRange | null = null;
  /**
   * Where the loop starts and ends in the music (its first tick and its last), found in the tick
   * lookup its ticks were given in: a new sound whose ticks moved (a repeat or a time signature
   * changed) takes the loop to the same music, whether or not the page has set it again by then.
   */
  private loopPlaces: { start: Place; last: Place } | null = null;
  /**
   * Where playback was in the music when a new sound started being made, by bar id: once it is in
   * place, playback goes back there, at the ticks of the new sound. Null when playback was sent
   * somewhere meanwhile, or that place could not be told.
   */
  private resumeAt: Place | null = null;
  private destroyed = false;
  /** There is a player: a sound font asked for, and a browser alphaTab can play in. */
  private readonly plays: boolean;

  constructor(
    private element: HTMLElement,
    options: EngineOptions,
  ) {
    this.scale = options.scale ?? 1;
    this.plays = options.soundFont !== null && canPlaySound();
    // A browser that cannot play: alphaTab is not asked to try (it would log an error), and the
    // page is told so from the start (docs/spec/playback.md, 4.1).
    if (options.soundFont !== null && !this.plays) this.playerState = "unavailable";
    const settings = new alphaTab.Settings();
    settings.core.fontDirectory = options.fontDirectory;
    settings.core.useWorkers = options.useWorkers ?? true;
    settings.core.includeNoteBounds = true;
    settings.core.enableLazyLoading = true; // partial layout needs it
    settings.display.layoutMode = alphaTab.LayoutMode.Page;
    settings.display.staveProfile = alphaTab.StaveProfile.Default;
    settings.display.scale = this.scale;
    settings.notation.rhythmMode = alphaTab.TabRhythmMode.ShowWithBars;
    if (!this.plays || options.soundFont === null) {
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
      // At the end of a loop alphaTab reports where it got to, at or past the end, before it goes
      // back: playback has not left the loop.
      const loop = this.loop;
      const tick = loop && event.currentTick >= loop.endTick ? Math.max(loop.endTick - 1, loop.startTick) : event.currentTick;
      this.lastPosition = { tick, endTick: event.endTick, milliseconds: event.currentTime, endMilliseconds: event.endTime };
      this.positions.emit(this.lastPosition);
    });
    api.midiLoaded.on(() => {
      // The worker keeps the mutes and solos of the channels through a new sound, whatever parts
      // play on them now, and forgets the loop: both are given anew, before playback goes on.
      this.applyMix();
      this.relocateLoop();
      this.sendLoop();
      this.onSoundSettled();
    });
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

  boundsOfBars(anchorBarId: string, focusBarId: string): Rect[] {
    const lookup = this.api.boundsLookup;
    if (lookup === null || this.projection === null) return [];
    return barRangeRects(lookup, this.projection, this.parts, anchorBarId, focusBarId, this.metrics()).map((rect) => this.fromSurface(rect));
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
    // Before the player is ready alphaTab makes the sound itself, once it is. Nothing is drawn
    // (`drawNothing`), nothing to hear: alphaTab's model is an older score's.
    if (!this.plays || this.api.score === null || !this.playerIsReady || this.projection === null) return Promise.resolve();
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
    if (previous === null) this.resumeAt = this.placeOf(this.currentTick(), this.projection);
    this.reload.loads += 1;
    this.api.loadMidiForScore();
  }

  play(): void {
    // A score with no bars or no parts plays nothing; alphaTab still holds an older score's sound.
    if (!this.plays || this.projection === null) return;
    this.intendsToPlay = true;
    // While a new sound is made, it plays once that is in place.
    if (this.reload === null) this.api.play();
  }

  pause(): void {
    if (!this.plays) return;
    this.intendsToPlay = false;
    this.api.pause();
    // alphaTab has stopped to take the new sound, and reports nothing of the member's pause.
    if (this.reload) this.setState("paused");
  }

  stop(): void {
    if (!this.plays) return;
    this.intendsToPlay = false;
    // alphaTab stops at the start of the loop, when there is one: playback is there from now on,
    // before alphaTab reports it.
    const start = this.loop?.startTick ?? 0;
    this.resumeAt = null;
    this.sentTo = { tick: start, at: performance.now() };
    this.lastPosition = { ...this.lastPosition, tick: start };
    this.api.stop();
    if (this.reload) this.setState("paused");
  }

  get state(): PlayerState {
    return this.playerState;
  }

  get position(): PlayerPosition {
    // While a new sound is made, the page reads positions with the tick lookup of the new score
    // already: where playback was is told in its ticks.
    const place = this.resumeAt;
    const tick = place && this.api.tickCache !== place.cache ? this.tickOfPlace(place) : null;
    return tick === null ? this.lastPosition : { ...this.lastPosition, tick };
  }

  seek(tick: number): void {
    if (!this.plays) return;
    // Within the loop, when there is one, as alphaTab keeps it: outside it, to its nearer end.
    const loop = this.loop;
    const within = loop ? Math.min(Math.max(tick, loop.startTick), loop.endTick) : tick;
    // While a new sound is made, alphaTab goes back to the start after this: it comes back here
    // then, not to where it was before (the tick is the new sound's: `tickOf` reads its lookup).
    this.resumeAt = null;
    this.sentTo = { tick: within, at: performance.now() };
    this.api.tickPosition = within;
  }

  /** Send playback to where a beat starts, the first time its bar is played (as alphaTab's own seek on a click). */
  private seekToBeat(beat: alphaTab.model.Beat): void {
    const cache = this.api.tickCache;
    if (cache === null) return;
    // Within the loop, when there is one: a click outside it goes to its nearer end (`seek`).
    this.seek(cache.getMasterBarStart(beat.voice.bar.masterBar) + this.beatTicks(cache, beat).startTick);
  }

  /** Where a beat is played in its bar, as the sound has it; a beat changed since the sound was made, as the model has it. */
  private beatTicks(cache: alphaTab.midi.MidiTickLookup, beat: alphaTab.model.Beat): PlayRange {
    const played = cache.getRelativeBeatPlaybackRange(beat);
    return played ? { startTick: played.startTick, endTick: played.endTick } : { startTick: beat.playbackStart, endTick: beat.playbackStart + beat.playbackDuration };
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

  loopOf(selection: Selection): PlayRange | null {
    const cache = this.api.tickCache;
    const projection = this.projection;
    if (cache === null || projection === null) return null;
    const masterBarOf = (barId: string) => {
      const index = projection.barIndex.get(barId);
      return index === undefined ? undefined : projection.score.masterBars[index];
    };
    if (selection.kind === "bars") {
      const ends = [masterBarOf(selection.anchorBarId), masterBarOf(selection.focusBarId)];
      if (ends[0] === undefined || ends[1] === undefined) return null;
      const [first, last] = ends[0].index <= ends[1].index ? [ends[0], ends[1]] : [ends[1], ends[0]];
      // A bar the sound does not have yet is looked up as starting and ending at 0.
      const range = { startTick: cache.getMasterBar(first).start, endTick: cache.getMasterBar(last).end };
      return range.endTick > range.startTick ? range : null;
    }
    const masterBar = masterBarOf(selection.barId);
    const anchor = beatOf(projection, selection.anchorBeatId);
    const focus = beatOf(projection, selection.focusBeatId);
    if (masterBar === undefined || anchor === null || focus === null) return null;
    const start = cache.getMasterBar(masterBar).start;
    const ticks = [this.beatTicks(cache, anchor), this.beatTicks(cache, focus)];
    const range = { startTick: start + Math.min(...ticks.map((each) => each.startTick)), endTick: start + Math.max(...ticks.map((each) => each.endTick)) };
    return range.endTick > range.startTick ? range : null;
  }

  setMute(partId: string, mute: boolean): void {
    this.changeMix(partId, { mute });
  }

  setSolo(partId: string, solo: boolean): void {
    this.changeMix(partId, { solo });
  }

  setVolume(partId: string, volume: number): void {
    this.changeMix(partId, { volume });
  }

  setSpeed(speed: number): void {
    this.api.playbackSpeed = speed;
  }

  setLoop(range: PlayRange | null): void {
    const loop = this.loop;
    if (range === null ? loop === null : loop !== null && loop.startTick === range.startTick && loop.endTick === range.endTick) return;
    this.loop = range && { startTick: range.startTick, endTick: range.endTick };
    this.loopPlaces = this.placesOf(this.loop);
    this.sendLoop();
    // alphaTab goes to the start of a new range: playback stays where it was, when that is inside
    // it. While a new sound is made, it goes back there once that is in place, within the loop.
    if (range !== null && this.reload === null) this.seek(this.currentTick());
  }

  setMetronome(on: boolean): void {
    this.api.metronomeVolume = on ? 1 : 0;
  }

  setCountIn(on: boolean): void {
    this.api.countInVolume = on ? 1 : 0;
  }

  settings(): PlayerSettings {
    const api = this.api;
    return {
      speed: api.playbackSpeed,
      metronome: api.metronomeVolume > 0,
      countIn: api.countInVolume > 0,
      loop: this.loop && { ...this.loop },
      parts: Object.fromEntries([...this.mix].map(([partId, mix]) => [partId, { ...mix }])),
    };
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
    if (score.bars.length === 0 || score.parts.length === 0) {
      this.drawNothing();
      return;
    }
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
    if (this.playerIsReady && this.plays) {
      // Where playback is, in the old score's sound (alphaTab makes the new one's tick lookup with the model).
      if (this.reload === null) this.resumeAt = this.placeOf(this.currentTick(), previous);
      this.reload ??= { loads: 0, done: () => {} };
      this.reload.loads += 1;
    }
    this.api.renderScore(projection.score, this.trackIndexes(projection), hints);
  }

  /**
   * A score with no bars or no parts, as two members who each delete one of the last two bars, or
   * of the last two parts, at once leave it (docs/spec/commands.md, sections 7.3 and 9): alphaTab
   * can neither lay one out nor make its sound (it throws), so it is not given one. What it drew
   * before is taken off the page, nothing is placed on it, and playback stops; until the score has
   * bars and parts again nothing plays, and the next such score is a new model, drawn and heard anew.
   */
  private drawNothing(): void {
    this.projection = null;
    this.layoutChanged = false;
    const surface = this.element.querySelector<HTMLElement>(".at-surface");
    surface?.replaceChildren();
    if (surface) surface.style.height = "0px";
    if (this.playerIsReady) this.api.stop();
    this.rendered.emit({ partial: false, timings: { ...NO_TIMINGS } });
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

  private changeMix(partId: string, change: Partial<PartMix>): void {
    this.mix.set(partId, { ...(this.mix.get(partId) ?? NEUTRAL_MIX), ...change });
    this.applyMix();
  }

  /**
   * Give alphaTab the member's mix, by the channels the parts play on now: what it had before is
   * cleared first, the mute or solo of a channel another part played on then included. (Clearing
   * also clears the transpositions of the channels: the projection writes none.)
   */
  private applyMix(): void {
    const player = this.api.player;
    const projection = this.projection;
    if (player === null || projection === null) return;
    player.resetChannelStates();
    const channels = projection.score.tracks.map((track) => ({ primary: track.playbackInfo.primaryChannel, secondary: track.playbackInfo.secondaryChannel }));
    const mixes = projection.partIds.map((partId) => this.mix.get(partId) ?? NEUTRAL_MIX);
    for (const [channel, mix] of channelMixOf(channels, mixes)) {
      player.setChannelVolume(channel, mix.volume);
      if (mix.mute) player.setChannelMute(channel, true);
      if (mix.solo) player.setChannelSolo(channel, true);
    }
  }

  /** The place in the music played at a tick of the sound in place, with the bar ids of a projection. */
  private placeOf(tick: number, projection: Projection | null): Place | null {
    const cache = this.api.tickCache;
    const place = cache && placeAtTick(cache, tick);
    const barId = place && projection?.barIds[place.index];
    return cache && place && barId ? { barId, pass: place.pass, offset: place.offset, cache } : null;
  }

  /** The tick of a place in the music, in the sound in place now; null for a bar it does not have. */
  private tickOfPlace(place: Place): number | null {
    const cache = this.api.tickCache;
    const index = this.projection?.barIndex.get(place.barId);
    return cache === null || index === undefined ? null : tickAtPlace(cache, { index, pass: place.pass, offset: place.offset });
  }

  /** Where a range starts and ends in the music, in the tick lookup in place; null before there is one. */
  private placesOf(range: PlayRange | null): { start: Place; last: Place } | null {
    if (range === null) return null;
    const start = this.placeOf(range.startTick, this.projection);
    const last = this.placeOf(range.endTick - 1, this.projection);
    return start && last ? { start, last } : null;
  }

  /**
   * A new sound is in: the loop covers the same music in its ticks. Set in this sound's ticks
   * already (the page set it again once the new score was drawn), it stays as it is.
   */
  private relocateLoop(): void {
    const places = this.loopPlaces;
    if (this.loop === null || places === null || places.start.cache === this.api.tickCache) return;
    const start = this.tickOfPlace(places.start);
    const last = this.tickOfPlace(places.last);
    // A bar of it gone: the page sets the loop of the selection as it is now.
    if (start === null || last === null || last < start) return;
    this.loop = { startTick: start, endTick: last + 1 };
    this.loopPlaces = this.placesOf(this.loop);
  }

  /** Tell alphaTab the loop, or that there is none. */
  private sendLoop(): void {
    const loop = this.loop;
    if (loop === null) {
      this.api.playbackRange = null;
      this.api.isLooping = false;
      return;
    }
    const range = new alphaTab.synth.PlaybackRange();
    range.startTick = loop.startTick;
    range.endTick = loop.endTick;
    this.api.playbackRange = range;
    this.api.isLooping = true;
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
    // The same place in the music: a repeat or a time signature changed, or bars added before it,
    // move it to other ticks.
    const place = this.resumeAt;
    const tick = place && this.tickOfPlace(place);
    this.seek(tick ?? this.currentTick());
    // Where playback is now, in the ticks of the new sound, before alphaTab reports from there.
    this.lastPosition = { ...this.lastPosition, tick: this.currentTick() };
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
