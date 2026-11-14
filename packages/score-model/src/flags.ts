// What is wrong in a score but is never rewritten for the members: only pointed out.
import type { BeatDuration, BeatJSON, NoteJSON, PartJSON, ScoreJSON, TimeSignature } from "./schema";

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

/**
 * A note marked to go on from another that is not there (docs/spec/flags.md, section 1): a tie
 * with no same note just before it, a link (#27) with no note on its string just after it.
 */
export interface LinkFlag {
  kind: "danglingTie" | "danglingLink";
  partId: string;
  barId: string;
  voice: string;
  beatId: string;
  noteKey: string;
}

export type Flag = DurationFlag | LinkFlag | InvalidContentFlag;

/**
 * Whether a tied note goes on from the note with its key on the beat before: on a fretted part,
 * on the same fret (the key is the string); on a pitched one, the key is the pitch itself.
 */
function continues(kind: PartJSON["kind"], tied: NoteJSON, before: NoteJSON | undefined): boolean {
  if (before === undefined) return false;
  return kind !== "fretted" || (tied.fret !== undefined && before.fret === tied.fret);
}

/** Where a flag stands in the score, to put the flags in order: what it has no part, bar, voice or beat for comes first. */
type Rank = [part: number, bar: number, voice: string, beat: number];

function compareRanks(a: Rank, b: Rank): number {
  return a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0) || a[3] - b[3];
}

/**
 * What is wrong in a score, in score order (docs/spec/flags.md, section 3): by part, bar, voice,
 * then beat, what stands for a whole part, bar or voice before what is in it, and what is not in
 * the score (a part or a beat reading left out) after what is. `invalid` is the invalid content
 * reading found (`readScore`), merged in. An empty voice is a whole-bar rest, not a flag; the
 * first bar, when it is a pickup, is never underfull.
 */
export function flagsOf(score: ScoreJSON, invalid: readonly InvalidContentFlag[] = []): Flag[] {
  const flags: Flag[] = [];
  const partIndex = new Map(score.parts.map((part, index) => [part.id, index]));
  const barIndex = new Map(score.bars.map((bar, index) => [bar.id, index]));
  /** Each beat's index in its voice, by beat id. */
  const beatIndex = new Map<string, number>();
  for (const part of score.parts) {
    /** The last beat of each voice in the bar before. */
    let lastOf = new Map<string, BeatJSON>();
    for (const [index, bar] of score.bars.entries()) {
      const voices = Object.entries(part.content[bar.id] ?? {});
      for (const [voice, beats] of voices) {
        if (beats.length === 0) continue;
        const fill = fillOf(beats.reduce((sum, beat) => sum + beatTicks(beat), 0), barTicks(bar.timeSig));
        if (fill !== null && !(fill === "underfull" && index === 0 && bar.anacrusis)) flags.push({ kind: fill, partId: part.id, barId: bar.id, voice });
        let before = lastOf.get(voice);
        for (const [position, beat] of beats.entries()) {
          beatIndex.set(beat.id, position);
          for (const [noteKey, note] of Object.entries(beat.notes)) {
            if (note.tie && !continues(part.kind, note, before?.notes[noteKey])) flags.push({ kind: "danglingTie", partId: part.id, barId: bar.id, voice, beatId: beat.id, noteKey });
          }
          before = beat;
        }
      }
      lastOf = new Map(voices.flatMap(([voice, beats]) => (beats.length === 0 ? [] : [[voice, beats.at(-1)!] as const])));
    }
  }
  const rankOf = (flag: Flag): Rank => [
    flag.partId === undefined ? -1 : (partIndex.get(flag.partId) ?? Infinity),
    flag.barId === undefined ? -1 : (barIndex.get(flag.barId) ?? Infinity),
    flag.voice ?? "",
    !("beatId" in flag) || flag.beatId === undefined ? -1 : (beatIndex.get(flag.beatId) ?? Infinity),
  ];
  // A stable sort: flags at the same place keep the order they were found in.
  return [...flags, ...invalid].map((flag) => ({ flag, rank: rankOf(flag) })).sort((a, b) => compareRanks(a.rank, b.rank)).map(({ flag }) => flag);
}
