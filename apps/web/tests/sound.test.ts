// When the page asks for the sound of the score again after a change (docs/spec/playback.md,
// section 3): (a) once typing stops for 400 ms, (b) never while playing. The player is a stand-in
// whose state and position the test sets; the clock is vitest's.
import type { PlayerPosition, PlayerState } from "@studio/score-render";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { SOUND_DELAY, soundUpdates, type SoundUpdates } from "../src/sound";

class FakePlayer {
  state: PlayerState = "paused";
  loads = 0;
  private states = new Set<(state: PlayerState) => void>();
  private positions = new Set<(position: PlayerPosition) => void>();

  load(): Promise<void> {
    this.loads += 1;
    return Promise.resolve();
  }

  onState(listener: (state: PlayerState) => void) {
    this.states.add(listener);
    return () => this.states.delete(listener);
  }

  onPosition(listener: (position: PlayerPosition) => void) {
    this.positions.add(listener);
    return () => this.positions.delete(listener);
  }

  /** The player says it is in a state now. */
  now(state: PlayerState): void {
    this.state = state;
    for (const listener of this.states) listener(state);
  }

  /** The player says where playback is. */
  at(tick: number): void {
    for (const listener of this.positions) listener({ tick, endTick: 100_000, milliseconds: 0, endMilliseconds: 0 });
  }
}

let player: FakePlayer;
let sound: SoundUpdates;
let notices: boolean[];
let loaded: number;

function start(mode: "a" | "b"): void {
  sound?.destroy();
  player = new FakePlayer();
  loaded = 0;
  sound = soundUpdates(player, mode, () => (loaded += 1));
  notices = [];
  sound.onBehind((behind) => notices.push(behind));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  sound.destroy();
  vi.useRealTimers();
});

test("(a): one load, 400 ms after the last change, playing or not; nothing said", async () => {
  start("a");
  player.now("playing");
  sound.changed();
  vi.advanceTimersByTime(300);
  sound.changed();
  vi.advanceTimersByTime(300);
  sound.changed();
  vi.advanceTimersByTime(SOUND_DELAY - 1);
  expect(player.loads).toBe(0);
  vi.advanceTimersByTime(1);
  expect(player.loads).toBe(1);
  // Told once the sound is in place.
  await vi.runAllTimersAsync();
  expect(loaded).toBe(1);
  vi.advanceTimersByTime(10 * SOUND_DELAY);
  expect(player.loads).toBe(1);

  // Paused: the same.
  player.now("paused");
  sound.changed();
  vi.advanceTimersByTime(SOUND_DELAY);
  expect(player.loads).toBe(2);
  expect(notices).toEqual([]);
});

test("(a): pausing, stopping or going back does not load anything more", () => {
  start("a");
  player.now("playing");
  player.at(5000);
  sound.changed();
  player.at(1000);
  player.now("paused");
  expect(player.loads).toBe(0);
  vi.advanceTimersByTime(SOUND_DELAY);
  expect(player.loads).toBe(1);
});

test("(b): changes while playing load nothing and say so; a pause loads once, and the notice goes", () => {
  start("b");
  player.now("playing");
  player.at(1000);
  sound.changed();
  sound.changed();
  vi.advanceTimersByTime(10 * SOUND_DELAY);
  player.at(2000);
  expect(player.loads).toBe(0);
  expect(sound.behind).toBe(true);
  expect(notices).toEqual([true]);
  player.now("paused");
  expect(player.loads).toBe(1);
  expect(notices).toEqual([true, false]);
  // Playing again with nothing changed: nothing to load.
  player.now("playing");
  player.now("paused");
  expect(player.loads).toBe(1);
});

test("(b): a stop loads once (the player reports a stop as paused)", () => {
  start("b");
  player.now("playing");
  player.at(3000);
  sound.changed();
  // A stop sends playback back to the start, then the player says it is paused.
  player.at(0);
  player.now("paused");
  expect(player.loads).toBe(1);
});

test("(b): playback going back (a loop starting again) loads once, and playback goes on", () => {
  start("b");
  player.now("playing");
  player.at(5000);
  sound.changed();
  player.at(6000);
  expect(player.loads).toBe(0);
  player.at(1000);
  expect(player.loads).toBe(1);
  expect(sound.behind).toBe(false);
  // Going back again, with nothing changed since.
  player.at(6000);
  player.at(1000);
  expect(player.loads).toBe(1);
});

test("(b): a change while paused is heard 400 ms later, as in (a), unless playback started meanwhile", () => {
  start("b");
  sound.changed();
  vi.advanceTimersByTime(SOUND_DELAY);
  expect(player.loads).toBe(1);
  sound.changed();
  player.now("playing");
  vi.advanceTimersByTime(SOUND_DELAY);
  expect(player.loads).toBe(1);
  expect(sound.behind).toBe(true);
});

test("a new model makes the whole sound: what was waiting is heard, and the notice goes", () => {
  start("b");
  player.now("playing");
  sound.changed();
  expect(sound.behind).toBe(true);
  sound.remade();
  expect(sound.behind).toBe(false);
  player.now("paused");
  expect(player.loads).toBe(0);

  start("a");
  sound.changed();
  sound.remade();
  vi.advanceTimersByTime(SOUND_DELAY);
  expect(player.loads).toBe(0);
});

test("switched to (a) while (b) held changes: heard 400 ms later; switched to (b) while playing: held", () => {
  start("b");
  player.now("playing");
  sound.changed();
  sound.setMode("a");
  expect(sound.behind).toBe(false);
  vi.advanceTimersByTime(SOUND_DELAY);
  expect(player.loads).toBe(1);

  sound.changed();
  sound.setMode("b");
  vi.advanceTimersByTime(SOUND_DELAY);
  expect(player.loads).toBe(1);
  expect(sound.behind).toBe(true);
});
