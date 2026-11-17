// When the page asks the player to make the sound of the score again (`ScorePlayer.load`) after
// the content of bars changed, one's own changes and other members' alike (docs/spec/playback.md,
// section 3). A change of bars or parts is a new model, whose sound the player makes by itself.
//  (a) once typing stops for 400 ms, playing or not;
//  (b) never while playing: once playback pauses, stops or goes back (a loop starting again, a
//      seek back), the page saying meanwhile that what plays is the score before the change.
import type { PlayerState, ScorePlayer, Unsubscribe } from "@studio/score-render";

import type { WhilePlaying } from "./mixer";

/** Changes are heard once typing stops for this long, in milliseconds (behaviour (a)). */
export const SOUND_DELAY = 400;

export interface SoundUpdates {
  /** The content of some bars changed: in place, the sound is that of the score before. */
  changed(): void;
  /** The player made the whole sound anew (a new model): every change so far is heard. */
  remade(): void;
  setMode(mode: WhilePlaying): void;
  /** (b): playback goes on with the sound of the score before a change. */
  readonly behind: boolean;
  onBehind(listener: (behind: boolean) => void): Unsubscribe;
  destroy(): void;
}

/** `afterLoad` is called each time a sound asked for is in place. */
export function soundUpdates(player: Pick<ScorePlayer, "load" | "state" | "onState" | "onPosition">, initialMode: WhilePlaying, afterLoad: () => void = () => {}): SoundUpdates {
  let mode = initialMode;
  /** Changes made since the sound was asked for last. */
  let pending = false;
  let behind = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastState: PlayerState = player.state;
  let lastTick: number | null = null;
  const listeners = new Set<(behind: boolean) => void>();

  function setBehind(now: boolean): void {
    if (now === behind) return;
    behind = now;
    for (const listener of listeners) listener(now);
  }

  function cancel(): void {
    clearTimeout(timer);
    timer = undefined;
  }

  /** Ask for the sound of the score as it is now, once for every change made so far. */
  function load(): void {
    cancel();
    if (!pending) return;
    pending = false;
    setBehind(false);
    void player.load().then(afterLoad);
  }

  /** (b) holds the changes while it plays. */
  const holding = () => mode === "b" && player.state === "playing";

  function later(): void {
    cancel();
    timer = setTimeout(() => {
      timer = undefined;
      if (holding()) setBehind(true);
      else load();
    }, SOUND_DELAY);
  }

  const offState = player.onState((state) => {
    const was = lastState;
    lastState = state;
    // Paused or stopped (alike to the player): (b) makes the sound now, as (a) does once its time is up.
    if (was === "playing" && state !== "playing" && mode === "b" && pending) load();
  });
  const offPosition = player.onPosition(({ tick }) => {
    const before = lastTick;
    lastTick = tick;
    if (before !== null && tick < before && holding() && pending) load();
  });

  return {
    changed() {
      pending = true;
      if (holding()) {
        // Nothing more to wait for: it is heard once playback pauses, stops or goes back.
        cancel();
        setBehind(true);
      } else later();
    },
    remade() {
      cancel();
      pending = false;
      setBehind(false);
    },
    setMode(next) {
      mode = next;
      if (!pending) return;
      // What (b) held is heard as (a) would hear it; what (a) waited for, as (b) would.
      if (mode === "a") {
        setBehind(false);
        later();
      } else if (holding()) {
        cancel();
        setBehind(true);
      }
    },
    get behind() {
      return behind;
    },
    onBehind(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      cancel();
      offState();
      offPosition();
      listeners.clear();
    },
  };
}
