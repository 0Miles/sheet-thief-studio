// Each member's own playback settings (docs/spec/playback.md, section 1). They live in this browser
// only (localStorage), never in the score: the mix and the speed of each score under its id, the
// metronome, the count-in and what a change does while playing for every score at once. The loop
// comes from the selection and is not stored.
import { NEUTRAL_MIX, type PartMix, type ScorePlayer } from "@studio/score-render";

import { readStored, writeStored } from "./storage";

/** The speeds offered, 1 being the tempo of the score: 0.25 to 1.5, every 0.05. */
export const SPEEDS: readonly number[] = Array.from({ length: 26 }, (_, step) => Math.round((0.25 + step * 0.05) * 100) / 100);

/** Volumes go from 0 (silent) to 1 (as the score has it), every 0.05. */
export const VOLUME_STEP = 0.05;

/**
 * What a change does while the score plays (docs/spec/playback.md, section 3): heard once typing
 * stops for 400 ms ("a"), or only once playback pauses, stops or loops back ("b").
 */
export type WhilePlaying = "a" | "b";

/** The mix and the speed of one score. */
export interface ScoreMix {
  /** By part id; a part not in here plays as the score has it. */
  parts: Map<string, PartMix>;
  speed: number;
}

/** The settings of every score. */
export interface PlaybackOptions {
  metronome: boolean;
  countIn: boolean;
  whilePlaying: WhilePlaying;
}

/** Where a score's mix is stored. */
export const mixerKey = (scoreId: string) => `studio.mixer.${scoreId}`;
/** Where the settings of every score are stored. */
export const PLAYBACK_KEY = "studio.playback";

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A volume as stored, to the nearest step from 0 to 1; anything else is the score's own. */
function volumeOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.round(Math.min(Math.max(value, 0), 1) / VOLUME_STEP) / (1 / VOLUME_STEP);
}

/** A score's mix as stored; what cannot be read is left as the score has it. */
export function loadMix(scoreId: string): ScoreMix {
  const stored = readStored(mixerKey(scoreId));
  const parts = new Map<string, PartMix>();
  const storedParts = isObject(stored) ? stored.parts : undefined;
  if (isObject(storedParts)) {
    // Own fields only (JSON.parse makes "__proto__" one), into a Map: an id is never a property name.
    for (const [partId, mix] of Object.entries(storedParts)) {
      if (!isObject(mix)) continue;
      parts.set(partId, { mute: mix.mute === true, solo: mix.solo === true, volume: volumeOf(mix.volume) });
    }
  }
  const speed = isObject(stored) && typeof stored.speed === "number" && SPEEDS.includes(stored.speed) ? stored.speed : 1;
  return { parts, speed };
}

/**
 * Store a score's mix. Parts left as the score has them are not written; parts deleted since keep
 * their entry, so that an undo brings their mix back with them.
 */
export function saveMix(scoreId: string, mix: ScoreMix): void {
  const parts = Object.fromEntries([...mix.parts].filter(([, part]) => !isNeutral(part)));
  writeStored(mixerKey(scoreId), { parts, speed: mix.speed });
}

export function isNeutral(mix: PartMix): boolean {
  return mix.mute === NEUTRAL_MIX.mute && mix.solo === NEUTRAL_MIX.solo && mix.volume === NEUTRAL_MIX.volume;
}

/** The mix of a part: its own, or the score's. */
export function partMix(mix: ScoreMix, partId: string): PartMix {
  return mix.parts.get(partId) ?? NEUTRAL_MIX;
}

/** The settings of every score, as stored; off and (a) unless stored otherwise. */
export function loadPlayback(): PlaybackOptions {
  const stored = readStored(PLAYBACK_KEY);
  const fields = isObject(stored) ? stored : {};
  return { metronome: fields.metronome === true, countIn: fields.countIn === true, whilePlaying: fields.whilePlaying === "b" ? "b" : "a" };
}

export function savePlayback(options: PlaybackOptions): void {
  writeStored(PLAYBACK_KEY, options);
}

/** What `startPlayback` gives the settings to. */
export type MixedPlayer = Pick<ScorePlayer, "setSpeed" | "setMetronome" | "setCountIn" | "setMute" | "setSolo" | "setVolume">;

/**
 * A score is opened: its player starts with the member's settings as stored, which the page then
 * shows. The player keeps the mix of a part not drawn yet for when it is.
 */
export function startPlayback(scoreId: string, player: MixedPlayer): { mix: ScoreMix; playback: PlaybackOptions } {
  const mix = loadMix(scoreId);
  const playback = loadPlayback();
  player.setSpeed(mix.speed);
  player.setMetronome(playback.metronome);
  player.setCountIn(playback.countIn);
  for (const [partId, part] of mix.parts) {
    player.setMute(partId, part.mute);
    player.setSolo(partId, part.solo);
    player.setVolume(partId, part.volume);
  }
  return { mix, playback };
}
