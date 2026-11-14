// The player while it makes a new sound (docs/spec/playback.md, sections 3 and 4.1). alphaTab
// stops and rewinds to make it, and its worker reports every step later, in a fixed order. The
// alphaTab API is replaced here by a stand-in that reports nothing by itself: the test sends the
// worker's reports, in alphaTab 1.9's order (`newSound`), and the stand-in's cached state and
// position change only with them, as alphaTab's do. Everything else is alphaTab's own: the
// settings, the model, the projection, and the tick lookup made with the sound.
import * as alphaTab from "@coderline/alphatab";
import { addPart, createScore, docToJson, insertBars, type ScoreJSON } from "@studio/score-model";
import { beforeEach, expect, test, vi } from "vitest";
import * as Y from "yjs";

import { createAlphaTabEngine, type PlayerState, type ScoreEngine } from "../src/index";

const { PlayerState: AtState } = alphaTab.synth;
/** A bar of 4/4, in ticks. */
const BAR = 3840;

class Event<T = void> {
  private listeners: ((value: T) => void)[] = [];
  on(listener: (value: T) => void): void {
    this.listeners.push(listener);
  }
  emit(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
}

interface Position {
  currentTick: number;
  endTick: number;
  currentTime: number;
  endTime: number;
}

/**
 * alphaTab's API as far as the engine uses it. What alphaTab does on the page's thread happens at
 * once (the drawing, the tick lookup of a new sound); what its worker reports, the test sends.
 */
class StandIn {
  readonly settings: alphaTab.Settings;
  readonly renderer = { partialRenderFinished: new Event<{ firstMasterBarIndex: number; lastMasterBarIndex: number }>() };
  readonly postRenderFinished = new Event();
  readonly error = new Event<Error>();
  readonly playerReady = new Event();
  readonly playerStateChanged = new Event<{ state: alphaTab.synth.PlayerState }>();
  readonly playerFinished = new Event();
  readonly playerPositionChanged = new Event<Position>();
  readonly midiLoaded = new Event();
  readonly beatMouseUp = new Event<alphaTab.model.Beat | null>();
  /** The player behind the API: a sound the worker could not take is reported by it alone. */
  readonly player = { midiLoadFailed: new Event<Error>() };
  score: alphaTab.model.Score | null = null;
  tickCache: alphaTab.midi.MidiTickLookup | null = null;
  readonly boundsLookup = null;
  isLooping = false;
  /** The sound font is in: alphaTab makes a new model's sound as it gets the model. */
  ready = false;
  /** What the engine asked of alphaTab, in order; `seek:<tick>` for a position set. */
  readonly calls: string[] = [];
  /** How many notes each sound made holds, in order. */
  readonly heard: number[] = [];
  /** As the worker last reported them (alphaTab's caches). */
  reportedState = AtState.Paused;
  reportedTick = 0;

  constructor(_element: unknown, settings: alphaTab.Settings) {
    this.settings = settings;
    standIns.push(this);
  }

  get playerState(): alphaTab.synth.PlayerState {
    return this.reportedState;
  }

  get tickPosition(): number {
    return this.reportedTick;
  }

  /** alphaTab keeps the position it is sent at once, and tells its worker. */
  set tickPosition(tick: number) {
    this.calls.push(`seek:${tick}`);
    this.reportedTick = tick;
  }

  renderScore(score: alphaTab.model.Score): void {
    this.calls.push("renderScore");
    if (score === this.score) return;
    this.score = score;
    this.tickCache = null;
    if (this.ready) this.loadMidiForScore();
  }

  render(): void {
    this.calls.push("render");
  }

  renderTracks(tracks: alphaTab.model.Track[]): void {
    this.calls.push(`renderTracks:${tracks.map((track) => track.index).join(",")}`);
  }

  updateSettings(): void {
    this.calls.push(`updateSettings:${this.settings.display.scale}`);
  }

  /** The tick lookup is made at once, on the page's thread; the worker takes the sound later. */
  loadMidiForScore(): void {
    this.calls.push("loadMidi");
    const file = new alphaTab.midi.MidiFile();
    const generator = new alphaTab.midi.MidiFileGenerator(this.score!, this.settings, new alphaTab.midi.AlphaSynthMidiFileHandler(file));
    generator.generate();
    this.tickCache = generator.tickLookup;
    this.heard.push(file.events.filter((event) => event instanceof alphaTab.midi.NoteOnEvent).length);
  }

  play(): void {
    this.calls.push("play");
  }

  pause(): void {
    this.calls.push("pause");
  }

  stop(): void {
    this.calls.push("stop");
  }

  destroy(): void {}
}

const standIns: StandIn[] = [];

vi.mock("@coderline/alphatab", async (importOriginal) => {
  const real = await importOriginal<typeof import("@coderline/alphatab")>();
  // Looked up when the engine makes its API, after this file has run.
  return {
    ...real,
    AlphaTabApi: function (element: unknown, settings: alphaTab.Settings) {
      return new StandIn(element, settings);
    },
  };
});

/** A score of `bars` empty bars of 4/4 and one guitar. */
function scoreOf(bars: number): ScoreJSON {
  const doc = new Y.Doc();
  createScore(doc, "Engine");
  insertBars(doc, { after: null, count: bars });
  addPart(doc, { name: "Guitar", kind: "fretted" });
  return docToJson(doc);
}

/** The score with a quarter note on the top string of the guitar in a bar, by index. */
function withFret(json: ScoreJSON, bar: number, fret: number): ScoreJSON {
  const barId = json.bars[bar]!.id;
  const parts = json.parts.map((part) => ({ ...part, content: { ...part.content, [barId]: { "0:0": [{ id: `fret-${bar}`, value: 4, dots: 0, notes: { s1: { fret } } }] } } }));
  return { ...json, parts } as ScoreJSON;
}

let engine: ScoreEngine;
let api: StandIn;
let score: ScoreJSON;
/** Every state and every position the engine told, in order. */
let states: PlayerState[];
let positions: number[];

/** The worker reports a position. */
function at(tick: number): void {
  api.reportedTick = tick;
  api.playerPositionChanged.emit({ currentTick: tick, endTick: 8 * BAR, currentTime: 0, endTime: 0 });
}

/** The worker reports a state. */
function now(state: "playing" | "paused"): void {
  api.reportedState = state === "playing" ? AtState.Playing : AtState.Paused;
  api.playerStateChanged.emit({ state: api.reportedState });
}

/**
 * The worker took a new sound, reporting as alphaTab 1.9 does (`AlphaSynth.loadMidiFile` and the
 * page's side of its messages): it stopped, back at the start; ready (the page's side checks
 * before passing midiLoaded on); midiLoaded; ready again; at the start again.
 */
function newSound(): void {
  at(0);
  now("paused");
  api.playerReady.emit();
  api.midiLoaded.emit();
  api.playerReady.emit();
  at(0);
}

/**
 * The worker could not take the new sound, reporting as alphaTab 1.9 does: it stopped, back at
 * the start; ready (the page's side checks before passing the failure on); the failure, from
 * the player only (the API tells it as an error).
 */
function soundFailed(): void {
  at(0);
  now("paused");
  api.playerReady.emit();
  api.player.midiLoadFailed.emit(new Error("The sound could not be loaded"));
}

/** What the engine asked of alphaTab since the last call to this. */
let seen = 0;
function asked(): string[] {
  const calls = api.calls.slice(seen);
  seen = api.calls.length;
  return calls;
}

/** An engine drawing an 8-bar score, its first sound in place, paused at the start; clicks seek with `seekOnClick`. */
function start(options: { seekOnClick?: boolean } = {}): void {
  standIns.length = 0;
  engine = createAlphaTabEngine({} as HTMLElement, { fontDirectory: "/font/", soundFont: "/soundfont/test.sf3", useWorkers: false, ...options });
  api = standIns[0]!;
  score = scoreOf(8);
  engine.renderer.setScore(score);
  api.postRenderFinished.emit();
  // The sound font is in: alphaTab makes the first sound itself.
  api.ready = true;
  api.loadMidiForScore();
  newSound();
  states = [];
  positions = [];
  engine.player.onState((state) => states.push(state));
  engine.player.onPosition((position) => positions.push(position.tick));
  seen = api.calls.length;
}

beforeEach(() => start());

/** Playing, as alphaTab reports it, at a tick. */
function playingAt(tick: number): void {
  engine.player.play();
  expect(asked()).toEqual(["play"]);
  now("playing");
  at(tick);
  states = [];
  positions = [];
}

/** A change of content, made in place in the model and drawn: the sound is not that of the score any more. */
function changeInPlace(): void {
  engine.renderer.patchBars(score, [score.bars[1]!.id]);
  api.postRenderFinished.emit();
  expect(asked()).toEqual(["render"]);
}

test("the first sound makes the player ready, paused", () => {
  expect(engine.player.state).toBe("paused");
});

test("while it plays, a new sound: never paused, the start it went back to is never told, and it plays on from where it was", async () => {
  playingAt(5000);
  changeInPlace();
  const loaded = engine.player.load();
  expect(asked()).toEqual(["loadMidi"]);
  newSound();
  await loaded;
  expect(asked()).toEqual(["seek:5000", "play"]);
  // The worker goes there and plays on.
  at(5000);
  now("playing");
  at(5100);
  expect(states).toEqual([]);
  expect(positions).toEqual([5000, 5100]);
  expect(engine.player.state).toBe("playing");
});

test("paused before alphaTab reported it, then a new sound: it stays paused, where it was", async () => {
  playingAt(5000);
  engine.player.pause();
  expect(asked()).toEqual(["pause"]);
  changeInPlace();
  const loaded = engine.player.load();
  // The worker pauses, then takes the new sound: the page hears of both only now.
  now("paused");
  newSound();
  await loaded;
  expect(asked()).toEqual(["loadMidi", "seek:5000"]);
  expect(engine.player.state).toBe("paused");
  expect(positions).toEqual([]);
});

test("a second new sound before alphaTab reports playing again: it plays on, from the same place", async () => {
  playingAt(5000);
  changeInPlace();
  const first = engine.player.load();
  newSound();
  await first;
  expect(asked()).toEqual(["loadMidi", "seek:5000", "play"]);
  // Changed again before the worker reports the seek and the play.
  changeInPlace();
  const second = engine.player.load();
  expect(asked()).toEqual(["loadMidi"]);
  at(5000);
  now("playing");
  newSound();
  await second;
  expect(asked()).toEqual(["seek:5000", "play"]);
  expect(states).toEqual([]);
  expect(positions).toEqual([]);
});

test("stopped while the new sound is made: it does not play again, and stays at the start", async () => {
  playingAt(5000);
  changeInPlace();
  const loaded = engine.player.load();
  engine.player.stop();
  expect(engine.player.state).toBe("paused");
  newSound();
  await loaded;
  expect(asked()).toEqual(["loadMidi", "stop", "seek:0"]);
  expect(engine.player.state).toBe("paused");
});

test("paused while the new sound is made: it does not play again, and stays where it was", async () => {
  playingAt(5000);
  changeInPlace();
  const loaded = engine.player.load();
  engine.player.pause();
  expect(engine.player.state).toBe("paused");
  newSound();
  await loaded;
  expect(asked()).toEqual(["loadMidi", "pause", "seek:5000"]);
  expect(states).toEqual(["paused"]);
});

test("paused, a change of the bars makes a new sound and playback stays where it was", () => {
  at(5000);
  positions = [];
  const nine = scoreOf(9);
  engine.renderer.setScore(nine);
  expect(asked()).toEqual(["renderScore", "loadMidi"]);
  newSound();
  expect(asked()).toEqual(["seek:5000"]);
  at(5000);
  expect(positions).toEqual([5000]);
  expect(engine.player.state).toBe("paused");
  expect(states).toEqual([]);
});

test("played while a new model's sound is made: it plays from the start of the bar asked, once the sound is in", () => {
  const nine = scoreOf(9);
  engine.renderer.setScore(nine);
  // alphaTab makes the tick lookup of the new model with it, before the worker has the sound.
  const third = engine.player.tickOf(nine.bars[2]!.id);
  expect(third).toBe(2 * BAR);
  engine.player.seek(third!);
  engine.player.play();
  expect(asked()).toEqual(["renderScore", "loadMidi", `seek:${2 * BAR}`]);
  newSound();
  expect(asked()).toEqual([`seek:${2 * BAR}`, "play"]);
});

test("a change of content that needs a new model makes the sound once, not again when asked", async () => {
  // A second voice in a bar: the bars cannot be replaced in place, the model is made again.
  const barId = score.bars[1]!.id;
  const twoVoices: ScoreJSON = {
    ...score,
    parts: score.parts.map((part) => ({ ...part, content: { ...part.content, [barId]: { "0:0": [], "0:1": [{ id: "b1", value: 4, dots: 0, notes: {} }] } } })) as ScoreJSON["parts"],
  };
  engine.renderer.patchBars(twoVoices, [barId]);
  api.postRenderFinished.emit();
  const loaded = engine.player.load();
  newSound();
  await loaded;
  expect(asked().filter((call) => call === "loadMidi")).toEqual(["loadMidi"]);
});

test("a change that waits for the drawing before it is heard too: the sound is made once it is in the model, and is in place only then", async () => {
  const first = withFret(score, 1, 5);
  const second = withFret(first, 2, 7);
  // Drawing the first change; the second waits for it.
  engine.renderer.patchBars(first, [first.bars[1]!.id]);
  engine.renderer.patchBars(second, [second.bars[2]!.id]);
  let inPlace = false;
  const loaded = engine.player.load().then(() => {
    inPlace = true;
  });
  expect(asked()).toEqual(["render"]);
  // The first is drawn: the second goes into the model and is drawn, and the sound is made of both.
  api.postRenderFinished.emit();
  expect(asked()).toEqual(["render", "loadMidi"]);
  expect(api.heard.at(-1)).toBe(2);
  await Promise.resolve();
  expect(inPlace).toBe(false);
  newSound();
  await loaded;
  expect(inPlace).toBe(true);
});

test("a new sound the worker could not take: nothing waits for it any more, and playback goes on from where it was", async () => {
  playingAt(5000);
  changeInPlace();
  const loaded = engine.player.load();
  expect(asked()).toEqual(["loadMidi"]);
  soundFailed();
  await loaded;
  expect(asked()).toEqual(["seek:5000", "play"]);
  at(5000);
  now("playing");
  // The member's pause is alphaTab's to report again.
  engine.player.pause();
  expect(asked()).toEqual(["pause"]);
  expect(engine.player.state).toBe("playing");
  now("paused");
  expect(states).toEqual(["paused"]);
  expect(positions).toEqual([5000]);
});

test("a new zoom asked for while a change is drawn: the score is drawn again at that scale after it", () => {
  engine.renderer.patchBars(score, [score.bars[1]!.id]);
  engine.renderer.setScale(1.5);
  expect(asked()).toEqual(["render", "updateSettings:1.5"]);
  api.postRenderFinished.emit();
  expect(asked()).toEqual(["renderTracks:0"]);
  // Drawn: nothing more to do.
  api.postRenderFinished.emit();
  expect(asked()).toEqual([]);
});

test("the same zoom again draws nothing", () => {
  engine.renderer.setScale(1);
  expect(asked()).toEqual([]);
});

test("with seekOnClick, a click on a beat sends playback to it; while a new sound is made, there once it is in", () => {
  start({ seekOnClick: true });
  const beatIn = (bar: number) => api.score!.tracks[0]!.staves[0]!.bars[bar]!.voices[0]!.beats[0]!;
  api.beatMouseUp.emit(beatIn(2));
  expect(asked()).toEqual([`seek:${2 * BAR}`]);
  // Off the beats: nothing.
  api.beatMouseUp.emit(null);
  expect(asked()).toEqual([]);
  engine.renderer.setScore(scoreOf(9));
  expect(asked()).toEqual(["renderScore", "loadMidi"]);
  api.beatMouseUp.emit(beatIn(4));
  newSound();
  expect(asked()).toEqual([`seek:${4 * BAR}`, `seek:${4 * BAR}`]);
});

test("without seekOnClick, a click on a beat leaves playback where it is", () => {
  api.beatMouseUp.emit(api.score!.tracks[0]!.staves[0]!.bars[2]!.voices[0]!.beats[0]!);
  expect(asked()).toEqual([]);
});
