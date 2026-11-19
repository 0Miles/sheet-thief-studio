import type { PlayerState } from "./types";

/**
 * Whether the player can be asked to play, pause or stop: its sound is in (paused or playing).
 * Not while it is loading, nor when its soundfont could not be had, nor ever in a browser with no
 * Web Audio (docs/spec/playback.md, 4.1).
 */
export function playerUsable(state: PlayerState): boolean {
  return state === "paused" || state === "playing";
}
