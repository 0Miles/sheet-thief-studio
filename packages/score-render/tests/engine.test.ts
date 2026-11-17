// The player while it makes a new sound (docs/spec/playback.md, sections 3 and 4.1). alphaTab
// stops and rewinds to make it, and its worker reports every step later, in a fixed order. The
// alphaTab API is replaced here by a stand-in that reports nothing by itself: the test sends the
// worker's reports, in alphaTab 1.9's order (`newSound`), and the stand-in's cached state and
// position change only with them, as alphaTab's do. Everything else is alphaTab's own: the
// settings, the model, the projection, and the tick lookup made with the sound.
import * as alphaTab from "@coderline/alphatab";
import { addPart, createScore, docToJson, insertBars, type PartKind, type ScoreJSON } from "@studio/score-model";
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
  /** The player behind the API: a sound the worker could not take is reported by it alone; the channels' mix is set on it. */
  readonly player = new StandInPlayer();
  score: alphaTab.model.Score | null = null;
  tickCache: alphaTab.midi.MidiTickLookup | null = null;
  readonly boundsLookup = null;
  isLooping = false;
  metronomeVolume = 0;
  countInVolume = 0;
  playbackSpeed = 1;
  private range: alphaTab.synth.PlaybackRange | null = null;
  /** Every loop the engine gave alphaTab, in order: `start-end`, or `none`. */
  readonly ranges: string[] = [];
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

  get playbackRange(): alphaTab.synth.PlaybackRange | null {
    return this.range;
  }

  set playbackRange(range: alphaTab.synth.PlaybackRange | null) {
    this.range = range;
    this.ranges.push(range ? `${range.startTick}-${range.endTick}` : "none");
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

/**
 * The mix of alphaTab's synthesizer, by MIDI channel, as its worker keeps it: a new sound changes
 * none of it, and clearing it (`resetChannelStates`) clears the mutes and the solos, not the volumes.
 */
class StandInPlayer {
  readonly midiLoadFailed = new Event<Error>();
  readonly muted = new Set<number>();
  readonly soloed = new Set<number>();
  readonly volumes = new Map<number, number>();

  resetChannelStates(): void {
    this.muted.clear();
    this.soloed.clear();
  }

  setChannelMute(channel: number, mute: boolean): void {
    if (mute) this.muted.add(channel);
    else this.muted.delete(channel);
  }

  setChannelSolo(channel: number, solo: boolean): void {
    if (solo) this.soloed.add(channel);
    else this.soloed.delete(channel);
  }

  setChannelVolume(channel: number, volume: number): void {
    this.volumes.set(channel, volume);
  }
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

/** A score of `bars` empty bars of 4/4 and one guitar, or one part of another kind. */
function scoreOf(bars: number, kind: PartKind = "fretted"): ScoreJSON {
  const doc = new Y.Doc();
  createScore(doc, "Engine");
  insertBars(doc, { after: null, count: bars });
  addPart(doc, { name: "Part", kind });
  return docToJson(doc);
}

/** The score with a quarter note on the top string of the guitar in a bar, by index. */
function withFret(json: ScoreJSON, bar: number, fret: number): ScoreJSON {
  const barId = json.bars[bar]!.id;
  const parts = json.parts.map((part) => ({ ...part, content: { ...part.content, [barId]: { "0:0": [{ id: `fret-${bar}`, value: 4, dots: 0, notes: { s1: { fret } } }] } } }));
  return { ...json, parts } as ScoreJSON;
}

/** The first beat of the first voice of a bar of the guitar, by index, in the model alphaTab has. */
function beatIn(bar: number): alphaTab.model.Beat {
  return api.score!.tracks[0]!.staves[0]!.bars[bar]!.voices[0]!.beats[0]!;
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
  // An element with nothing drawn in it: what the engine clears when it draws nothing.
  engine = createAlphaTabEngine({ querySelector: () => null } as unknown as HTMLElement, { fontDirectory: "/font/", soundFont: "/soundfont/test.sf3", useWorkers: false, ...options });
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
  // The drawing under way is at the scale it started with: the page is measured with that one.
  expect(asked()).toEqual(["render"]);
  expect(api.settings.display.scale).toBe(1);
  api.postRenderFinished.emit();
  expect(asked()).toEqual(["updateSettings:1.5", "renderTracks:0"]);
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

test("with seekOnClick and a loop, a click outside the loop sends playback to its nearer end", () => {
  start({ seekOnClick: true });
  engine.player.setLoop({ startTick: 2 * BAR, endTick: 4 * BAR });
  // Playback, at the start, goes into the loop.
  expect(asked()).toEqual([`seek:${2 * BAR}`]);
  api.beatMouseUp.emit(beatIn(0));
  api.beatMouseUp.emit(beatIn(6));
  api.beatMouseUp.emit(beatIn(3));
  expect(asked()).toEqual([`seek:${2 * BAR}`, `seek:${4 * BAR}`, `seek:${3 * BAR}`]);
});

test("without seekOnClick, a click on a beat leaves playback where it is", () => {
  api.beatMouseUp.emit(beatIn(2));
  expect(asked()).toEqual([]);
});

test("a score with no parts, or no bars, is not given to alphaTab: told drawn, playback stopped, no sound made and nothing played until it has both again", async () => {
  const drawn: boolean[] = [];
  engine.renderer.onRendered(({ partial }) => drawn.push(partial));
  for (const empty of [{ ...score, parts: [] }, { ...score, bars: [], parts: [] }, { ...score, bars: [], parts: score.parts.map((part) => ({ ...part, content: {} })) }]) {
    engine.renderer.setScore(empty);
    expect(asked()).toEqual(["stop"]);
    // A change of content arriving for it is not given either.
    engine.renderer.patchBars(empty, []);
    expect(asked()).toEqual(["stop"]);
    await engine.player.load();
    engine.player.play();
    expect(asked()).toEqual([]);
  }
  expect(drawn).toEqual([false, false, false, false, false, false]);
  // Parts again: a new model, drawn and heard anew.
  engine.renderer.setScore(scoreOf(4));
  expect(asked()).toEqual(["renderScore", "loadMidi"]);
});

test("a score of drums only is drawn and heard as any other", () => {
  engine.renderer.setScore(scoreOf(4, "percussion"));
  expect(asked()).toEqual(["renderScore", "loadMidi"]);
  expect(api.score!.tracks.map((track) => track.staves[0]!.isPercussion)).toEqual([true]);
});

/** A score of `bars` empty bars of 4/4 and a part of each kind given, in that order. */
function partsScore(kinds: PartKind[], bars = 4): ScoreJSON {
  const doc = new Y.Doc();
  createScore(doc, "Mixer");
  insertBars(doc, { after: null, count: bars });
  for (const kind of kinds) addPart(doc, { name: kind, kind });
  return docToJson(doc);
}

/** The engine draws a new score, a new model, and the worker takes its sound. */
function newModel(json: ScoreJSON): void {
  engine.renderer.setScore(json);
  api.postRenderFinished.emit();
  newSound();
}

test("mute, solo and volume stay with their part when a part added before it moves it to other channels", () => {
  const two = partsScore(["fretted", "fretted"]);
  newModel(two);
  const [guitar, bass] = two.parts;
  engine.player.setVolume(guitar!.id, 0.5);
  engine.player.setMute(bass!.id, true);
  // Channels: the guitar 0 and 2, the bass 1 and 3.
  expect([...api.player.muted]).toEqual([1, 3]);
  expect(Object.fromEntries(api.player.volumes)).toEqual({ 0: 0.5, 1: 1, 2: 0.5, 3: 1 });

  // A part added between them: the guitar 0 and 3, the new part 1 and 4, the bass 2 and 5.
  const added = partsScore(["fretted"]).parts[0]!;
  newModel({ ...two, parts: [guitar!, added, bass!] });
  expect([...api.player.muted].sort()).toEqual([2, 5]);
  expect(Object.fromEntries(api.player.volumes)).toEqual({ 0: 0.5, 1: 1, 2: 1, 3: 0.5, 4: 1, 5: 1 });

  // Solo too, and moved again.
  engine.player.setMute(bass!.id, false);
  engine.player.setSolo(bass!.id, true);
  expect([...api.player.soloed].sort()).toEqual([2, 5]);
  newModel({ ...two, parts: [bass!, guitar!, added] });
  expect([...api.player.soloed].sort()).toEqual([0, 3]);
  expect(api.player.muted.size).toBe(0);
});

test("parts sharing a channel cannot be told apart: two drum parts, either muted, mute channel 9", () => {
  const drums = partsScore(["percussion", "percussion"]);
  newModel(drums);
  engine.player.setMute(drums.parts[1]!.id, true);
  expect([...api.player.muted]).toEqual([9]);
  engine.player.setVolume(drums.parts[0]!.id, 0.25);
  expect(api.player.volumes.get(9)).toBe(0.25);
});

test("a mix set before the first sound, or for a part not drawn yet, is given once there is one", () => {
  const two = partsScore(["fretted", "fretted"]);
  engine.player.setMute(two.parts[1]!.id, true);
  expect(api.player.muted.size).toBe(0);
  newModel(two);
  expect([...api.player.muted]).toEqual([1, 3]);
});

test("the metronome and the count-in are on at full volume, off at none", () => {
  expect([api.metronomeVolume, api.countInVolume]).toEqual([0, 0]);
  engine.player.setMetronome(true);
  engine.player.setCountIn(true);
  expect([api.metronomeVolume, api.countInVolume]).toEqual([1, 1]);
  engine.player.setMetronome(false);
  expect([api.metronomeVolume, api.countInVolume]).toEqual([0, 1]);
});

test("a selection of bars loops from the start of its first bar to the end of its last, whichever end it was made from", () => {
  const [, second, third] = score.bars;
  expect(engine.player.loopOf({ kind: "bars", partId: score.parts[0]!.id, anchorBarId: third!.id, focusBarId: second!.id })).toEqual({ startTick: BAR, endTick: 3 * BAR });
  expect(engine.player.loopOf({ kind: "bars", partId: score.parts[0]!.id, anchorBarId: "gone", focusBarId: second!.id })).toBeNull();
});

test("a selection of beats loops from the start of its first beat to the end of its last", () => {
  const barId = score.bars[1]!.id;
  const quarter = (id: string) => ({ id, value: 4, dots: 0, notes: { s1: { fret: 0 } } });
  const json = { ...score, parts: score.parts.map((part) => ({ ...part, content: { [barId]: { "0:0": [quarter("q1"), quarter("q2"), quarter("q3")] } } })) } as ScoreJSON;
  newModel(json);
  const selection = { kind: "beats", partId: json.parts[0]!.id, barId, voice: "0:0", anchorBeatId: "q3", focusBeatId: "q2" } as const;
  expect(engine.player.loopOf(selection)).toEqual({ startTick: BAR + 960, endTick: BAR + 3 * 960 });
});

test("a loop keeps playback where it is inside it, else sends it to the nearer end; alphaTab is given it again with every new sound", () => {
  at(5000);
  engine.player.setLoop({ startTick: BAR, endTick: 3 * BAR });
  expect(api.ranges.at(-1)).toBe(`${BAR}-${3 * BAR}`);
  expect(asked()).toEqual(["seek:5000"]);
  // The same loop again: nothing to do.
  const given = api.ranges.length;
  engine.player.setLoop({ startTick: BAR, endTick: 3 * BAR });
  expect(api.ranges.length).toBe(given);
  expect(asked()).toEqual([]);
  // A seek outside it goes to its nearer end; a stop to its start.
  engine.player.seek(7 * BAR);
  expect(asked()).toEqual([`seek:${3 * BAR}`]);
  engine.player.setLoop({ startTick: 4 * BAR, endTick: 6 * BAR });
  expect(asked()).toEqual([`seek:${4 * BAR}`]);

  // A new sound: the worker forgot the loop, and is given it again.
  engine.renderer.setScore(scoreOf(9));
  api.ranges.length = 0;
  newSound();
  expect(api.ranges).toEqual([`${4 * BAR}-${6 * BAR}`]);
  expect(api.isLooping).toBe(true);

  engine.player.setLoop(null);
  expect(api.ranges.at(-1)).toBe("none");
  expect(api.isLooping).toBe(false);
  engine.player.seek(7 * BAR);
  expect(asked().at(-1)).toBe(`seek:${7 * BAR}`);
});

test("a repeat set while it plays: once the new sound is in, playback goes on in the same bar, at the ticks of the new sound", () => {
  playingAt(4 * BAR + 100);
  // Bars 1 and 2 are now played twice: bar 5 is first played two bars later.
  const repeated = { ...score, bars: score.bars.map((bar, index) => (index === 1 ? { ...bar, repeatEnd: 2 } : bar)) } as ScoreJSON;
  engine.renderer.setScore(repeated);
  expect(asked()).toEqual(["renderScore", "loadMidi"]);
  newSound();
  expect(asked()).toEqual([`seek:${6 * BAR + 100}`, "play"]);
  expect(engine.player.barAt(6 * BAR + 100)).toEqual({ barId: score.bars[4]!.id, index: 4 });
});

test("in the second time through a repeat, a change made: playback goes on in that second time", async () => {
  const repeated = { ...score, bars: score.bars.map((bar, index) => (index === 1 ? { ...bar, repeatEnd: 2 } : bar)) } as ScoreJSON;
  newModel(repeated);
  score = repeated;
  asked();
  // Bar 2, the second time.
  playingAt(3 * BAR + 100);
  changeInPlace();
  const loaded = engine.player.load();
  newSound();
  await loaded;
  expect(asked()).toEqual(["loadMidi", `seek:${3 * BAR + 100}`, "play"]);
});

test("sent elsewhere while the new sound is made: playback goes there, not back to where it was", () => {
  playingAt(4 * BAR + 100);
  const repeated = { ...score, bars: score.bars.map((bar, index) => (index === 1 ? { ...bar, repeatEnd: 2 } : bar)) } as ScoreJSON;
  engine.renderer.setScore(repeated);
  engine.player.seek(BAR);
  // A loop set meanwhile does not send it anywhere either.
  engine.player.setLoop({ startTick: 0, endTick: 8 * BAR });
  newSound();
  expect(asked()).toEqual(["renderScore", "loadMidi", `seek:${BAR}`, `seek:${BAR}`, "play"]);
});

test("at the end of a loop, alphaTab's report from its end is told as the loop's last tick: playback never shows the bar after it", () => {
  engine.player.setLoop({ startTick: BAR, endTick: 3 * BAR });
  at(3 * BAR - 10);
  at(3 * BAR + 20);
  at(BAR);
  expect(positions).toEqual([3 * BAR - 10, 3 * BAR - 1, BAR]);
});

test("while the sound of a repeat set is made, where playback is reads in the new sound's ticks", () => {
  playingAt(4 * BAR + 100);
  const repeated = { ...score, bars: score.bars.map((bar, index) => (index === 1 ? { ...bar, repeatEnd: 2 } : bar)) } as ScoreJSON;
  engine.renderer.setScore(repeated);
  // The page asks, once drawn, with the new tick lookup already made.
  expect(engine.player.position.tick).toBe(6 * BAR + 100);
  expect(engine.player.barAt(engine.player.position.tick)).toEqual({ barId: score.bars[4]!.id, index: 4 });
});

/** The score with two empty bars inserted before its first. */
function twoBarsBefore(json: ScoreJSON): ScoreJSON {
  const first = json.bars[0]!;
  return { ...json, bars: [{ ...first, id: "before-1" }, { ...first, id: "before-2", tempo: undefined }, { ...first, tempo: undefined }, ...json.bars.slice(1)] } as ScoreJSON;
}

test("two bars inserted before it while it plays: once the new sound is in, where playback is stays in the new sound's ticks until alphaTab reports", () => {
  playingAt(4 * BAR + 100);
  engine.renderer.setScore(twoBarsBefore(score));
  expect(engine.player.position.tick).toBe(6 * BAR + 100);
  newSound();
  expect(asked()).toEqual(["renderScore", "loadMidi", `seek:${6 * BAR + 100}`, "play"]);
  // alphaTab has not reported from there yet.
  expect(engine.player.position.tick).toBe(6 * BAR + 100);
  expect(engine.player.barAt(engine.player.position.tick)).toEqual({ barId: score.bars[4]!.id, index: 6 });
});

test("stopped with a loop, playback is at the loop's start at once", () => {
  engine.player.setLoop({ startTick: 2 * BAR, endTick: 4 * BAR });
  asked();
  playingAt(3 * BAR + 100);
  engine.player.stop();
  expect(asked()).toEqual(["stop"]);
  expect(engine.player.position.tick).toBe(2 * BAR);
  // Without one, at the start of the score.
  engine.player.setLoop(null);
  playingAt(3 * BAR);
  engine.player.stop();
  expect(engine.player.position.tick).toBe(0);
});

/**
 * Bars 4-5 looped, near the end of bar 5, when a repeat is set on bar 2: the music of the loop is
 * two bars later in the new sound.
 */
function loopThenRepeat(): void {
  engine.player.setLoop({ startTick: 3 * BAR, endTick: 5 * BAR });
  asked();
  playingAt(5 * BAR - 100);
  engine.renderer.setScore({ ...score, bars: score.bars.map((bar, index) => (index === 1 ? { ...bar, repeatEnd: 2 } : bar)) } as ScoreJSON);
  expect(asked()).toEqual(["renderScore", "loadMidi"]);
}

test("a loop, then a repeat set before it while it plays; the page sets the loop again before the sound is in: the same music plays on", () => {
  loopThenRepeat();
  engine.player.setLoop({ startTick: 5 * BAR, endTick: 7 * BAR });
  newSound();
  expect(asked()).toEqual([`seek:${7 * BAR - 100}`, "play"]);
  expect(api.ranges.at(-1)).toBe(`${5 * BAR}-${7 * BAR}`);
});

test("a loop, then a repeat set before it while it plays; the sound is in before the page sets the loop again: the same music plays on", () => {
  loopThenRepeat();
  newSound();
  expect(asked()).toEqual([`seek:${7 * BAR - 100}`, "play"]);
  expect(api.ranges.at(-1)).toBe(`${5 * BAR}-${7 * BAR}`);
  expect(engine.player.settings().loop).toEqual({ startTick: 5 * BAR, endTick: 7 * BAR });
  // The page's loop, set again, is that one: nothing moves.
  engine.player.setLoop({ startTick: 5 * BAR, endTick: 7 * BAR });
  expect(asked()).toEqual([]);
});

test("the settings tell the speed, the metronome, the count-in, the loop and the mix of each part given one", () => {
  const partId = score.parts[0]!.id;
  engine.player.setSpeed(0.75);
  engine.player.setMetronome(true);
  engine.player.setMute(partId, true);
  engine.player.setLoop({ startTick: BAR, endTick: 2 * BAR });
  expect(engine.player.settings()).toEqual({
    speed: 0.75,
    metronome: true,
    countIn: false,
    loop: { startTick: BAR, endTick: 2 * BAR },
    parts: { [partId]: { mute: true, solo: false, volume: 1 } },
  });
});
