// The player while it takes a new sound (docs/spec/playback.md, section 3 and 4.1): alphaTab stops
// and rewinds when it makes the sound again, and tells so later, from its worker. alphaTab's own
// API is replaced here by a stand-in whose events the test sends, in the order alphaTab sends
// them; everything else (settings, the model, the projection) is alphaTab's.
import * as alphaTab from "@coderline/alphatab";
import { addPart, createScore, docToJson, insertBars, type ScoreJSON } from "@studio/score-model";
import { beforeEach, expect, test, vi } from "vitest";
import * as Y from "yjs";

import { createAlphaTabEngine, type ScoreEngine } from "../src/index";

const { PlayerState } = alphaTab.synth;

class Event<T = void> {
  private listeners: ((value: T) => void)[] = [];
  on(listener: (value: T) => void): void {
    this.listeners.push(listener);
  }
  emit(value: T): void {
    for (const listener of this.listeners) listener(value);
  }
}

/** alphaTab's API as far as the engine uses it; what alphaTab does at once is done at once, what its worker tells later is sent by the test. */
class StandIn {
  readonly settings: alphaTab.Settings;
  readonly renderer = { partialRenderFinished: new Event<{ firstMasterBarIndex: number; lastMasterBarIndex: number }>() };
  readonly postRenderFinished = new Event();
  readonly error = new Event<Error>();
  readonly playerReady = new Event();
  readonly playerStateChanged = new Event<{ state: alphaTab.synth.PlayerState }>();
  readonly playerFinished = new Event();
  readonly playerPositionChanged = new Event<{ currentTick: number; endTick: number; currentTime: number; endTime: number }>();
  readonly midiLoaded = new Event();
  score: alphaTab.model.Score | null = null;
  readonly tickCache = null;
  readonly boundsLookup = null;
  playerState = PlayerState.Paused;
  tickPosition = 0;
  isLooping = false;
  /** The sound font is in: a new score's sound is made as alphaTab gets it. */
  ready = false;
  /** What the engine asked of alphaTab, in order. */
  readonly calls: string[] = [];

  constructor(_element: unknown, settings: alphaTab.Settings) {
    this.settings = settings;
    standIns.push(this);
  }

  renderScore(score: alphaTab.model.Score): void {
    this.calls.push("renderScore");
    const fresh = score !== this.score;
    this.score = score;
    if (fresh && this.ready) this.loadMidiForScore();
  }

  render(): void {
    this.calls.push("render");
  }

  /** alphaTab stops and goes back to the start at once; it says it stopped after `midiLoaded`. */
  loadMidiForScore(): void {
    this.calls.push("loadMidi");
    this.playerState = PlayerState.Paused;
    this.tickPosition = 0;
  }

  play(): void {
    this.calls.push("play");
    this.playerState = PlayerState.Playing;
  }

  pause(): void {
    this.calls.push("pause");
    this.playerState = PlayerState.Paused;
  }

  stop(): void {
    this.calls.push("stop");
    this.playerState = PlayerState.Paused;
    this.tickPosition = 0;
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

let engine: ScoreEngine;
let api: StandIn;

/** An engine with its sound in place, paused at the start of an 8-bar score. */
beforeEach(() => {
  standIns.length = 0;
  engine = createAlphaTabEngine({} as HTMLElement, { fontDirectory: "/font/", soundFont: "/soundfont/test.sf3", useWorkers: false });
  api = standIns[0]!;
  engine.renderer.setScore(scoreOf(8));
  api.postRenderFinished.emit();
  api.ready = true;
  api.playerReady.emit();
});

/** Playing, at a tick. */
function playingAt(tick: number): void {
  engine.player.play();
  api.playerStateChanged.emit({ state: PlayerState.Playing });
  api.tickPosition = tick;
  expect(engine.player.state).toBe("playing");
}

/** alphaTab tells that the new sound is in place, then that it stopped to take it. */
function soundTaken(): void {
  api.midiLoaded.emit();
  api.playerStateChanged.emit({ state: PlayerState.Paused });
}

test("playing on after a new sound: back where it was, and still playing", async () => {
  playingAt(5000);
  const loaded = engine.player.load();
  soundTaken();
  await loaded;
  expect(api.tickPosition).toBe(5000);
  expect(api.calls.at(-1)).toBe("play");
  api.playerStateChanged.emit({ state: PlayerState.Playing });
  expect(engine.player.state).toBe("playing");
});

test("stopped while the new sound is made: it does not play again, and stays at the start", async () => {
  playingAt(5000);
  const loaded = engine.player.load();
  engine.player.stop();
  soundTaken();
  await loaded;
  expect(api.calls.slice(api.calls.indexOf("stop"))).toEqual(["stop"]);
  expect(api.tickPosition).toBe(0);
  expect(engine.player.state).toBe("paused");
});

test("paused while the new sound is made: it does not play again, and stays where it was", async () => {
  playingAt(5000);
  const loaded = engine.player.load();
  engine.player.pause();
  soundTaken();
  await loaded;
  expect(api.calls.slice(api.calls.indexOf("pause"))).toEqual(["pause"]);
  expect(api.tickPosition).toBe(5000);
  expect(engine.player.state).toBe("paused");
});

test("paused, a change of the bars makes a new sound and playback stays where it was", () => {
  api.tickPosition = 5000;
  api.playerPositionChanged.emit({ currentTick: 5000, endTick: 30_720, currentTime: 0, endTime: 0 });
  engine.renderer.setScore(scoreOf(9));
  expect(api.calls).toContain("loadMidi");
  // alphaTab tells where it went back to: not a position of the playback.
  api.playerPositionChanged.emit({ currentTick: 0, endTick: 0, currentTime: 0, endTime: 0 });
  soundTaken();
  expect(api.tickPosition).toBe(5000);
  expect(api.calls).not.toContain("play");
  expect(engine.player.state).toBe("paused");
  expect(engine.player.position.tick).toBe(5000);
});

test("played while a new sound is made: it plays from the start of the bar asked, once the sound is in", () => {
  const score = scoreOf(9);
  engine.renderer.setScore(score);
  // The new sound is not made yet: where the bar starts is read from the score.
  const third = engine.player.tickOf(score.bars[2]!.id);
  expect(third).toBe(2 * 3840);
  engine.player.seek(third!);
  engine.player.play();
  expect(api.calls).not.toContain("play");
  soundTaken();
  expect(api.tickPosition).toBe(2 * 3840);
  expect(api.calls.at(-1)).toBe("play");
});

test("a change of content that needs a new model makes the sound once, not again when asked", async () => {
  const score = scoreOf(8);
  engine.renderer.setScore(score);
  api.postRenderFinished.emit();
  soundTaken();
  const before = api.calls.filter((call) => call === "loadMidi").length;
  // A second voice in a bar: the bars cannot be replaced in place, the model is made again.
  const barId = score.bars[1]!.id;
  const twoVoices: ScoreJSON = {
    ...score,
    parts: score.parts.map((part) => ({ ...part, content: { ...part.content, [barId]: { "0:0": [], "0:1": [{ id: "b1", value: 4, dots: 0, notes: {} }] } } })) as ScoreJSON["parts"],
  };
  engine.renderer.patchBars(twoVoices, [barId]);
  api.postRenderFinished.emit();
  const loaded = engine.player.load();
  soundTaken();
  await loaded;
  expect(api.calls.filter((call) => call === "loadMidi").length).toBe(before + 1);
});

test("a change of content replaced in place is heard once the sound is made again", async () => {
  const score = scoreOf(8);
  engine.renderer.setScore(score);
  api.postRenderFinished.emit();
  soundTaken();
  const before = api.calls.filter((call) => call === "loadMidi").length;
  engine.renderer.patchBars(score, [score.bars[1]!.id]);
  api.postRenderFinished.emit();
  expect(api.calls.at(-1)).toBe("render");
  const loaded = engine.player.load();
  soundTaken();
  await loaded;
  expect(api.calls.filter((call) => call === "loadMidi").length).toBe(before + 1);
});
