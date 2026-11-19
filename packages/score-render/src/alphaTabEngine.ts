// The renderer and the player on alphaTab 1.9: one alphaTab instance draws the score and plays it.
import * as alphaTab from "@coderline/alphatab";
import type { Cursor, PartKind, ScoreJSON, Selection } from "@studio/score-model";

import { channelMixOf, NEUTRAL_MIX, type PartMix } from "./channels";
import { barRangeRects, cursorAtPoint, cursorRect, type DrawnExtent, noteHeads, type PartShape, playbackRect, reservedRects, selectionRects, type StaffMetrics } from "./geometry";
import { playerUsable } from "./playerState";
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

  clear(): void {
    this.items.clear();
  }
}

const NO_TIMINGS: RenderTimings = { project: 0, finish: 0, render: 0 };

/** Where playback is before it has been anywhere; never changed in place. */
const NO_POSITION: PlayerPosition = { tick: 0, endTick: 0, milliseconds: 0, endMilliseconds: 0 };

/**
 * Whether alphaTab 1.9 can make a player that gets ready in this browser (#129: Playwright's
 * WebKit for Windows has no Web Audio). The output check is alphaTab's own, from
 * `BrowserUiFacade.createWorkerPlayer`: a script processor, or audio worklets on a secure page
 * (the engine leaves `player.outputMode` at its default, worklets); without either it logs
 * "browser unsupported" and makes no player. Two checks are added, each a failure alphaTab meets
 * only later, with an error, and the same outcome, a player that never gets ready:
 *  - a `Worker`: without one, `createAlphaSynthWebWorker` throws, alphaTab logs "Failed to create
 *    worker" and makes no player;
 *  - an `AudioContext` (or `webkitAudioContext`): without one, its output throws "AudioContext
 *    not found" when it starts (`WebAudioHelper.createAudioContext`).
 * So the answer is false exactly when alphaTab's player would fail, and it fails here instead,
 * without an error.
 */
function canPlaySound(): boolean {
  const scope = globalThis as unknown as Record<string, unknown>;
  const has = (name: string) => scope[name] != null;
  const context = has("AudioContext") || has("webkitAudioContext");
  const output = has("ScriptProcessorNode") || (scope.isSecureContext === true && has("AudioWorkletNode"));
  return has("Worker") && context && output;
}

/**
 * How many times the music font has been asked for again, by any engine on the page, after it
 * could not be had (#151). alphaTab 1.9 keeps the fonts it registers in a table of the page
 * (`BrowserUiFacade._registeredWebFonts`, by a hash of their sources): an API made with the
 * sources of one still on the page takes that one's font checker as it is, failed included, and
 * never checks again. Sources with another query are another entry, with a checker of its own.
 */
let fontAttempt = 0;

/**
 * The font faces that were on the page before the first API of the attempt in use was made: those
 * of other attempts, and whatever else the page has. alphaTab names a new font after how many its
 * table holds ("alphaTab", "alphaTab1"...) and takes one off the table with its last API, so a
 * name comes back, and a face of that name still on the page, failed or not, may be another
 * attempt's. Every API of an attempt uses the same sources, so the same font, whether it shares
 * the face of one still on the page or registers it anew: none of the faces from before the first
 * is theirs, and every face of their family since is (no API of an earlier attempt is made after).
 */
let facesBefore: { attempt: number; faces: Set<FontFace> } | null = null;

/** The faces that are not those of an API made now with the sources of the attempt (`facesBefore`). */
function facesOfOthers(attempt: number, fonts: FontFaceSet): Set<FontFace> {
  if (facesBefore?.attempt !== attempt) facesBefore = { attempt, faces: facesOn(fonts) };
  return facesBefore.faces;
}

/** The font faces on the page now. */
function facesOn(fonts: FontFaceSet): Set<FontFace> {
  const faces = new Set<FontFace>();
  fonts.forEach((face) => faces.add(face));
  return faces;
}

/**
 * The style elements of music fonts that could not be had, each put on the page by alphaTab for an
 * API still in use, of an engine that failed (#198). alphaTab 1.9 names a font after how many its
 * table holds, so the name of one still on the page comes back, and it checks a font by its family
 * alone (`FontLoadingChecker`: `document.fonts.load`, then `check`): with a failed font face of
 * the same family on the page, Chromium's and Firefox's alike, the check of a new font never
 * passes, and alphaTab never draws, telling no one. They are taken off the page, their font faces
 * with them, before the next API is made; the API they were for draws nothing anyway, and takes
 * its own off again, to no effect, when it is destroyed.
 */
const failedFontStyles = new Set<Element>();

/**
 * Called before the failed fonts are taken off the page, by every engine watching its font: each
 * notes which font faces on the page are its own. Two engines share the font of one attempt, and
 * the browser tells both of its failure one after the other: the first, asking again at once (back
 * online meanwhile), takes it off the page before the second has heard of it.
 */
const fontWatchers = new Set<() => void>();

/** The style elements on the page that declare a music font of this family from these sources, as alphaTab writes them (`_createStyleElements`). */
function fontStylesOf(family: string, sources: readonly string[]): Element[] {
  const page = (globalThis as { document?: Partial<Document> }).document;
  if (typeof page?.querySelectorAll !== "function") return [];
  return [...page.querySelectorAll("style")].filter((style) => {
    const css = style.textContent ?? "";
    return css.includes(`font-family: '${family}'`) && sources.every((url) => css.includes(`url(${JSON.stringify(url)})`));
  });
}

/** Where the music font is downloaded from on an attempt: alphaTab's own sources (null) the first time. */
function fontSources(fontDirectory: string, attempt: number): alphaTab.Settings["core"]["smuflFontSources"] {
  if (attempt === 0) return null;
  const sources = alphaTab.CoreSettings.buildDefaultSmuflFontSources(fontDirectory);
  for (const [format, url] of sources) sources.set(format, `${url}?attempt=${attempt}`);
  return sources;
}

/**
 * The workers made while `make` runs, in order. alphaTab 1.9 makes its own with `new Worker`
 * (alphaTab.mjs, `initializeMain`), from inside its API's constructor, and never listens for their
 * `error`: the global constructor is swapped, for that call only, for one that keeps them.
 */
function workersMadeBy<T>(make: () => T): { made: T; workers: Worker[] } {
  const scope = globalThis as unknown as { Worker?: typeof Worker };
  const Original = scope.Worker;
  if (typeof Original !== "function") return { made: make(), workers: [] };
  const workers: Worker[] = [];
  scope.Worker = class extends Original {
    constructor(...args: ConstructorParameters<typeof Worker>) {
      super(...args);
      workers.push(this);
    }
  };
  try {
    return { made: make(), workers };
  } finally {
    scope.Worker = Original;
  }
}

/**
 * Call `failed` when a worker reports an error before it has said anything: its script could not
 * be had (the network went, the server answered with an error), or did not start. An error after
 * it started is alphaTab's to report.
 */
function onStartFailure(worker: Worker, failed: () => void): () => void {
  let started = false;
  const onMessage = () => {
    started = true;
  };
  const onError = () => {
    if (!started) failed();
  };
  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  return () => {
    worker.removeEventListener("message", onMessage);
    worker.removeEventListener("error", onError);
  };
}

/** The family of a font face, as CSS has it, without quotes. */
function familyOf(face: FontFace): string {
  return face.family.replace(/^["']|["']$/g, "");
}

/**
 * What alphaTab needs and could not have (#151): the music font, the worker that lays out the
 * score (`useWorkers`), the worker that makes the sound. alphaTab asks for none of them again.
 */
type Missing = "font" | "layout" | "synth";

/** A place in the music by bar id (`placeAtTick`), and the tick lookup it was found in. */
interface Place {
  barId: string;
  pass: number;
  offset: number;
  cache: alphaTab.midi.MidiTickLookup;
}

class AlphaTabEngine implements ScoreRenderer, ScorePlayer {
  private api!: alphaTab.AlphaTabApi;
  /** The score asked for last: drawn again from scratch on a new API. */
  private latest: ScoreJSON | null = null;
  /** What the API in use could not have; had again only with a new API (`rebuild`). */
  private missing = new Set<Missing>();
  /** Stop listening to the API in use: its workers, and the fonts of the page. */
  private unwatch: (() => void)[] = [];
  private drawFailures = new Listeners<boolean>();
  private startsOver = new Listeners<void>();
  /** A new API is being made in place of another (`rebuild`): whether the score can be drawn is told once it is. */
  private rebuilding = false;
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
  private lastPosition: PlayerPosition = NO_POSITION;
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
   * every new sound, and every time the player is ready (`applyMix`).
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
  private readonly hasPlayer: boolean;
  /** Where the sound font is downloaded from, again after it could not be had. */
  private readonly soundFont: string | null;
  private readonly options: EngineOptions;
  /**
   * The browser came back online while nothing had failed (the sound font, the music font or a
   * worker still coming): should one fail after all (its failure reported after the browser was
   * online again), it is asked for again at once, not on the next time the browser comes back online.
   */
  private onlineWhilePending = false;
  /** Back online: what could not be had is asked for again; what is coming, should it fail. */
  private readonly onOnline = () => {
    if (this.missing.size > 0 || this.playerState === "failed") this.retry();
    else this.onlineWhilePending = true;
  };

  constructor(
    private element: HTMLElement,
    options: EngineOptions,
  ) {
    this.scale = options.scale ?? 1;
    this.options = options;
    const soundFont = options.soundFont;
    this.soundFont = soundFont;
    this.hasPlayer = soundFont !== null && canPlaySound();
    // A browser that cannot play: alphaTab is not asked to try (it would log an error), and the
    // page is told so from the start (docs/spec/playback.md, 4.1).
    if (soundFont !== null && !this.hasPlayer) this.playerState = "unavailable";
    window.addEventListener("online", this.onOnline);
    this.createApi();
  }

  /** Make alphaTab's API, and listen to it. */
  private createApi(): void {
    const options = this.options;
    const soundFont = this.soundFont;
    const attempt = fontAttempt;
    const settings = new alphaTab.Settings();
    settings.core.smuflFontSources = fontSources(options.fontDirectory, attempt);
    settings.core.fontDirectory = options.fontDirectory;
    settings.core.useWorkers = options.useWorkers ?? true;
    settings.core.includeNoteBounds = true;
    settings.core.enableLazyLoading = true; // partial layout needs it
    settings.display.layoutMode = alphaTab.LayoutMode.Page;
    settings.display.staveProfile = alphaTab.StaveProfile.Default;
    settings.display.scale = this.scale;
    settings.notation.rhythmMode = alphaTab.TabRhythmMode.ShowWithBars;
    // `soundFont === null` is in `hasPlayer` already; tested again only so that TypeScript knows
    // it is a string below (it does not narrow through a field).
    if (!this.hasPlayer || soundFont === null) {
      settings.player.playerMode = alphaTab.PlayerMode.Disabled;
    } else {
      settings.player.playerMode = alphaTab.PlayerMode.EnabledSynthesizer;
      settings.player.soundFont = soundFont;
      settings.player.scrollMode = alphaTab.ScrollMode.Off; // the page decides what scrolls
      // The page draws where playback is (`boundsAtTick`), clear of the reserved areas.
      settings.player.enableCursor = false;
      settings.player.enableSeekToClick = options.seekOnClick ?? false;
      // A loop comes from the member's selection, never from dragging over the score.
      settings.player.enablePlaybackRangeSelection = false;
      if (options.scrollElement) settings.player.scrollElement = options.scrollElement;
    }
    // Before alphaTab registers the font: the faces on the page that are not this API's.
    const fonts = (globalThis as { document?: Document }).document?.fonts;
    const others = fonts && facesOfOthers(attempt, fonts);
    // Nor a failed font left on the page, whose name alphaTab may give this API's (`failedFontStyles`).
    if (failedFontStyles.size > 0) {
      for (const remember of fontWatchers) remember();
      for (const style of failedFontStyles) style.remove();
      failedFontStyles.clear();
    }
    const { made: api, workers } = workersMadeBy(() => new alphaTab.AlphaTabApi(this.element, settings));
    this.api = api;
    // Every listener is added once, here: alphaTab calls a new listener of some events at once
    // with the last value (midiLoaded), so adding one later from inside a handler would loop.
    // Each hears its own API only: one replaced (`rebuild`) may still report.
    const live =
      <T extends unknown[]>(listener: (...args: T) => void) =>
      (...args: T): void => {
        if (this.api === api) listener(...args);
      };
    // Nor is anything drawn while the score cannot be (`failed`): a resize has alphaTab lay out
    // nothing and report it done all the same.
    api.postRenderFinished.on(
      live(() => {
        if (!this.failed) this.handleRendered();
      }),
    );
    api.renderer.partialRenderFinished.on(
      live((piece) => {
        const barIds = this.projection?.barIds.slice(Math.max(piece.firstMasterBarIndex, 0), piece.lastMasterBarIndex + 1) ?? [];
        this.painted.emit(barIds);
      }),
    );
    api.error.on((error) => console.error("[score-render]", error));
    // alphaTab makes a new sound in this order, its worker reporting each step: position 0,
    // paused, ready, midiLoaded, ready again, position 0 (alphaTab.core.mjs, `loadMidiFile`).
    api.playerReady.on(live(() => {
      // Every time it is ready, alphaTab's own listener, added before this one, has just set each
      // channel to the volume written in the score (`_setupPlayerWrapper`, after a new sound and
      // once the sound font is in): the member's mix is given again over it (#152).
      this.applyMix();
      // Said again after every new sound: only the first time is news.
      if (this.playerIsReady) return;
      this.playerIsReady = true;
      this.setState("paused");
      // The bars changed in place while there was no player (`load()` had nothing to do then, the
      // sound font long in coming, or not had at first): their sound is made now.
      if (this.soundStale) void this.load();
    }));
    api.playerStateChanged.on(live((event) => {
      // Not before the player can play (alphaTab reports "paused" as soon as a listener is
      // added), and not while it stops to take a new sound: that is not the member pausing.
      if (!this.playerIsReady || this.reload) return;
      this.setState(event.state === alphaTab.synth.PlayerState.Playing ? "playing" : "paused");
    }));
    api.playerFinished.on(live(() => {
      // At the end of a loop alphaTab goes back to its start and plays on.
      if (this.reload !== null || api.isLooping) return;
      this.intendsToPlay = false;
      this.finished.emit();
    }));
    api.playerPositionChanged.on(live((event) => {
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
    }));
    api.midiLoaded.on(live(() => {
      // The worker keeps the mutes and solos of the channels through a new sound, whatever parts
      // play on them now, and forgets the loop: both are given anew, before playback goes on.
      this.applyMix();
      this.relocateLoop();
      this.sendLoop();
      this.onSoundSettled();
    }));
    // A sound the worker could not take is over too (alphaTab tells the API only as an error):
    // nothing is to wait for it, and playback goes back to where it was.
    api.player?.midiLoadFailed.on(live(() => this.onSoundSettled()));
    // The sound font could not be had: the download failed (the network went), the server answered
    // with an error, or the worker could not read what came (alphaTab 1.9 reports all three so, and
    // tells the API only as an error). It is asked for again on `retry()`, or once the browser is
    // back online; alphaTab itself never asks again (docs/spec/playback.md, 4.1).
    if (this.hasPlayer) api.player?.soundFontLoadFailed.on(live(() => this.soundFontFailed()));
    // alphaTab seeks on a click only with its own cursor, which is off: the engine does it.
    if (options.seekOnClick) {
      api.beatMouseUp.on(
        live((beat) => {
          if (beat) this.seekToBeat(beat);
        }),
      );
    }
    // alphaTab makes the worker that lays out first (in its constructor), then the player's.
    const [layout, synth] = settings.core.useWorkers ? workers : [undefined, ...workers];
    if (layout) this.unwatch.push(onStartFailure(layout, live(() => this.fail("layout"))));
    if (synth && this.hasPlayer) this.unwatch.push(onStartFailure(synth, live(() => this.fail("synth"))));
    if (fonts && others) {
      const sources = settings.core.smuflFontSources ?? alphaTab.CoreSettings.buildDefaultSmuflFontSources(options.fontDirectory);
      this.watchFont(fonts, { attempt, sources: [...sources.values()] }, others, live(() => this.fail("font")));
    }
  }

  /**
   * Call `failed` when the music font of the API in use could not be had. alphaTab 1.9 tells no one
   * (its `FontLoadingChecker` logs "Loading Failed, rendering cannot start" and stops checking);
   * the page's fonts (`fonts`) do, by font face. The API's own faces are those of its family on the page
   * that are not another attempt's (`others`). One it shares with an API still on the page may
   * have failed already: no event comes for it again. A font that failed is taken off the page
   * before the next API is made (`failedFontStyles`), found by where it was asked for from (`asked`).
   */
  private watchFont(fonts: FontFaceSet, asked: { attempt: number; sources: string[] }, others: Set<FontFace>, failed: () => void): void {
    // The family alphaTab gave its font on this page: set by `BrowserUiFacade.initialize`, left
    // out of alphaTab's types.
    const family = (this.api.settings.display.resources as unknown as { smuflFontFamilyName?: string }).smuflFontFamilyName;
    if (family === undefined) return;
    const own = (face: FontFace) => familyOf(face) === family && !others.has(face);
    const fail = () => {
      // Any engine made from now on asks for it anew, as a retry of this one does.
      fontAttempt = Math.max(fontAttempt, asked.attempt + 1);
      for (const style of fontStylesOf(family, asked.sources)) failedFontStyles.add(style);
      failed();
    };
    // Its own faces that were on the page when the failed fonts were taken off it (`fontWatchers`).
    const takenOff = new Set<FontFace>();
    const remember = () => {
      for (const face of facesOn(fonts)) if (own(face)) takenOff.add(face);
    };
    const onError = (event: Event) => {
      // Not a face taken off the page (an API replaced), whatever its family; but for its own,
      // taken off as a failed font while this failure was being told.
      const onPage = facesOn(fonts);
      if ((event as FontFaceSetLoadEvent).fontfaces.some((face) => takenOff.has(face) || (onPage.has(face) && own(face)))) fail();
    };
    fonts.addEventListener("loadingerror", onError);
    fontWatchers.add(remember);
    this.unwatch.push(() => {
      fonts.removeEventListener("loadingerror", onError);
      fontWatchers.delete(remember);
    });
    if ([...facesOn(fonts)].some((face) => own(face) && face.status === "error")) fail();
  }

  // --- ScoreRenderer ---

  get failed(): boolean {
    return this.missing.has("font") || this.missing.has("layout");
  }

  onFailed(listener: (failed: boolean) => void): Unsubscribe {
    return this.drawFailures.add(listener);
  }

  onStartOver(listener: () => void): Unsubscribe {
    return this.startsOver.add(listener);
  }

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
    // Nothing is drawn (`drawNothing`, or starting over): what alphaTab still holds is an older drawing's.
    if (lookup === null || cache === null || this.projection === null) return null;
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
    window.removeEventListener("online", this.onOnline);
    this.stopWatching();
    // What alphaTab's workers report after this is told to no one.
    for (const listeners of [this.rendered, this.painted, this.states, this.positions, this.finished, this.drawFailures, this.startsOver]) listeners.clear();
    this.api.destroy();
  }

  private stopWatching(): void {
    for (const stop of this.unwatch) stop();
    this.unwatch = [];
  }

  // --- ScorePlayer ---

  load(): Promise<void> {
    // Before the player is ready alphaTab makes the sound itself, once it is. Nothing is drawn
    // (`drawNothing`), nothing to hear: alphaTab's model is an older score's.
    if (!this.hasPlayer || this.api.score === null || !this.playerIsReady || this.projection === null) return Promise.resolve();
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

  retry(): void {
    if (this.destroyed) return;
    // The music font or a worker: had again only with a new API, which downloads all of it again.
    if (this.missing.size > 0) {
      this.rebuild();
      return;
    }
    if (this.playerState !== "failed" || this.soundFont === null) return;
    this.onlineWhilePending = false;
    this.setState("loading");
    this.api.loadSoundFont(this.soundFont, false);
  }

  /**
   * A new alphaTab API in place of one that could not have what it needs (#151): the music font
   * (from new sources, `fontAttempt`), the workers and the sound font are downloaded again, and the
   * score asked for last is drawn from scratch. The member's mix, loop, speed, metronome and
   * count-in are kept; playback starts over, paused at the start, once the new player is ready.
   * The page is told first (`onStartOver`), with nothing of the score placed any more and what
   * the old API drew still on the page; whether the score can be drawn (`onFailed`) is told once
   * the new API is made, and only if that changed: one that fails as it is made (a font shared
   * with an engine whose font failed) leaves a failed score failed.
   */
  private rebuild(): void {
    const old = this.api;
    const kept = { speed: old.playbackSpeed, metronome: old.metronomeVolume, countIn: old.countInVolume };
    const wasFailed = this.failed;
    // What waited on the old API is over: the drawing under way, the sound being made.
    const reload = this.reload;
    const loads = this.loadsAfterDrawing;
    this.missing.clear();
    this.onlineWhilePending = false;
    this.reload = null;
    this.loadsAfterDrawing = [];
    this.running = null;
    this.waiting = null;
    this.layoutChanged = false;
    this.projection = null;
    this.soundStale = false;
    this.playerIsReady = false;
    this.intendsToPlay = false;
    this.sentTo = null;
    this.resumeAt = null;
    this.lastPosition = NO_POSITION;
    this.stopWatching();
    this.startsOver.emit();
    // Destroyed by the page as it was told.
    if (this.destroyed) return;
    old.destroy();
    this.rebuilding = true;
    try {
      this.createApi();
    } finally {
      this.rebuilding = false;
    }
    this.api.playbackSpeed = kept.speed;
    this.api.metronomeVolume = kept.metronome;
    this.api.countInVolume = kept.countIn;
    // Unless the new API could not have its player either, already (`fail` told the page so).
    if (this.hasPlayer && !this.missing.has("synth")) this.setState("loading");
    if (this.failed !== wasFailed) this.drawFailures.emit(this.failed);
    reload?.done();
    for (const done of loads) done();
    if (this.latest !== null) this.request({ score: this.latest, barIds: null });
  }

  play(): void {
    // A score with no bars or no parts plays nothing; alphaTab still holds an older score's sound.
    // Nor does a player with no sound font in.
    if (!playerUsable(this.playerState) || this.projection === null) return;
    this.intendsToPlay = true;
    // While a new sound is made, it plays once that is in place.
    if (this.reload === null) this.api.play();
  }

  pause(): void {
    if (!this.hasPlayer) return;
    this.intendsToPlay = false;
    this.api.pause();
    // alphaTab has stopped to take the new sound, and reports nothing of the member's pause.
    if (this.reload) this.setState("paused");
  }

  stop(): void {
    if (!this.hasPlayer) return;
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
    if (!this.hasPlayer) return;
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
    this.latest = request.score;
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
    if (this.playerIsReady && this.hasPlayer) {
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
   * The page is told it is drawn, unless the score cannot be (`failed`): then nothing is, as for
   * any other score, until a new API can (docs/spec/playback.md, 4.1).
   */
  private drawNothing(): void {
    this.projection = null;
    this.layoutChanged = false;
    const surface = this.element.querySelector<HTMLElement>(".at-surface");
    surface?.replaceChildren();
    if (surface) surface.style.height = "0px";
    if (this.playerIsReady) this.api.stop();
    if (!this.failed) this.rendered.emit({ partial: false, timings: { ...NO_TIMINGS } });
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

  /** The sound font could not be had; asked for again at once when the browser came back online meanwhile. */
  private soundFontFailed(): void {
    this.setState("failed");
    this.retryIfOnlineMeanwhile();
  }

  /**
   * What the API in use needs could not be had (#151). The page is told: the score cannot be drawn
   * (`failed`, `onFailed`), or the player cannot play ("failed").
   */
  private fail(what: Missing): void {
    if (this.destroyed || this.missing.has(what)) return;
    const wasFailed = this.failed;
    this.missing.add(what);
    if (what === "synth") this.setState("failed");
    // While a new API is made, `rebuild` tells it, once the API is in place.
    else if (!wasFailed && !this.rebuilding) this.drawFailures.emit(true);
    this.retryIfOnlineMeanwhile();
  }

  /** The browser came back online while it was coming: asked for again at once, this once. */
  private retryIfOnlineMeanwhile(): void {
    if (!this.onlineWhilePending) return;
    this.onlineWhilePending = false;
    this.retry();
  }

  private setState(state: PlayerState): void {
    // Destroyed, the engine tells the page nothing more (alphaTab's worker may still report).
    if (this.destroyed || state === this.playerState) return;
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
