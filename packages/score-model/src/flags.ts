// What is wrong in a score but is never rewritten for the members: only pointed out.
import type { BeatDuration, ScoreJSON, TimeSignature } from "./schema";

/** Ticks in a whole note (960 in a quarter). */
export const WHOLE = 3840;

const DOTTED = [1, 1.5, 1.75] as const;

export function beatTicks(beat: BeatDuration): number {
  const tuplet = beat.tuplet ? beat.tuplet.normal / beat.tuplet.actual : 1;
  return (WHOLE / beat.value) * DOTTED[beat.dots] * tuplet;
}

export function barTicks(timeSig: TimeSignature): number {
  return (WHOLE * timeSig.numerator) / timeSig.denominator;
}

/**
 * How the beats of a voice, `held` ticks in all, fill a bar of `room` ticks: null when they
 * fill it exactly (to half a tick: a triplet's thirds do not add up evenly).
 */
export function fillOf(held: number, room: number): "underfull" | "overfull" | null {
  if (Math.abs(held - room) < 0.5) return null;
  return held < room ? "underfull" : "overfull";
}

/** A voice that holds less, or more, than the time signature of its bar. */
export interface DurationFlag {
  kind: "underfull" | "overfull";
  partId: string;
  barId: string;
  voice: string;
}

/**
 * Invalid content: something in the document that does not fit the schema, left out when it is
 * read or read as its default (docs/spec/schema.md section 11). It says as much of where it
 * stands as is known.
 */
export interface InvalidContentFlag {
  kind: "invalidContent";
  partId?: string;
  barId?: string;
  voice?: string;
  beatId?: string;
  noteKey?: string;
  /** What could not be read: "bar.timeSig", "part.kind", "voice", "beat", "note"… */
  what: string;
}

export type Flag = DurationFlag | InvalidContentFlag;

/** Voices whose beats do not add up to their bar. An empty voice is a whole-bar rest, not a flag. */
export function flagsOf(score: ScoreJSON): Flag[] {
  const flags: Flag[] = [];
  for (const part of score.parts) {
    for (const bar of score.bars) {
      for (const [voice, beats] of Object.entries(part.content[bar.id] ?? {})) {
        if (beats.length === 0) continue;
        const fill = fillOf(beats.reduce((sum, beat) => sum + beatTicks(beat), 0), barTicks(bar.timeSig));
        if (fill !== null) flags.push({ kind: fill, partId: part.id, barId: bar.id, voice });
      }
    }
  }
  return flags;
}
