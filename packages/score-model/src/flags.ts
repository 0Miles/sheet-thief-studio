// What is wrong in a score but is never rewritten for the members: only pointed out.
import type { BeatJSON, ScoreJSON, TimeSignature } from "./schema";

/** Ticks in a whole note (960 in a quarter). */
export const WHOLE = 3840;

const DOTTED = [1, 1.5, 1.75] as const;

export function beatTicks(beat: BeatJSON): number {
  const tuplet = beat.tuplet ? beat.tuplet.normal / beat.tuplet.actual : 1;
  return (WHOLE / beat.value) * DOTTED[beat.dots] * tuplet;
}

export function barTicks(timeSig: TimeSignature): number {
  return (WHOLE * timeSig.numerator) / timeSig.denominator;
}

export interface Flag {
  /** The voice holds less, or more, than the time signature of its bar. */
  kind: "underfull" | "overfull";
  partId: string;
  barId: string;
  voice: string;
}

/** Voices whose beats do not add up to their bar. An empty voice is a whole-bar rest, not a flag. */
export function flagsOf(score: ScoreJSON): Flag[] {
  const flags: Flag[] = [];
  for (const part of score.parts) {
    for (const bar of score.bars) {
      for (const [voice, beats] of Object.entries(part.content[bar.id] ?? {})) {
        if (beats.length === 0) continue;
        const held = beats.reduce((sum, beat) => sum + beatTicks(beat), 0);
        const room = barTicks(bar.timeSig);
        if (Math.abs(held - room) < 0.5) continue;
        flags.push({ kind: held < room ? "underfull" : "overfull", partId: part.id, barId: bar.id, voice });
      }
    }
  }
  return flags;
}
