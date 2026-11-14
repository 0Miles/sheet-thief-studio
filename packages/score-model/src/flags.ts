// What is wrong in a score but is never rewritten for the members: only pointed out.
import type { Cursor } from "./commands";
import { type BeatDuration, type BeatJSON, MAIN_VOICE, type NoteJSON, type PartJSON, type ScoreJSON, startLine, type TimeSignature, voiceKeys } from "./schema";

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
        for (const beat of beats) {
          for (const [noteKey, note] of Object.entries(beat.notes)) {
            if (note.tie && !continues(part.kind, note, before?.notes[noteKey])) flags.push({ kind: "danglingTie", partId: part.id, barId: bar.id, voice, beatId: beat.id, noteKey });
          }
          before = beat;
        }
      }
      lastOf = new Map(voices.flatMap(([voice, beats]) => (beats.length === 0 ? [] : [[voice, beats.at(-1)!] as const])));
    }
  }
  const { rankOf } = placesIn(score);
  // A stable sort: flags at the same place keep the order they were found in.
  return [...flags, ...invalid].map((flag) => ({ flag, rank: rankOf(flag) })).sort((a, b) => compareRanks(a.rank, b.rank)).map(({ flag }) => flag);
}

/** Where flags and cursors stand in a score, as ranks to put them in order. */
function placesIn(score: ScoreJSON) {
  const partIndex = new Map(score.parts.map((part, index) => [part.id, index]));
  const barIndex = new Map(score.bars.map((bar, index) => [bar.id, index]));
  /** Each beat's index in its voice, by beat id. */
  const beatIndex = new Map<string, number>();
  for (const part of score.parts) for (const voices of Object.values(part.content)) for (const beats of Object.values(voices)) beats.forEach((beat, index) => beatIndex.set(beat.id, index));
  const partRank = (partId: string | undefined) => (partId === undefined ? -1 : (partIndex.get(partId) ?? Infinity));
  const barRank = (barId: string | undefined) => (barId === undefined ? -1 : (barIndex.get(barId) ?? Infinity));
  const beatRank = (beatId: string | undefined) => (beatId === undefined ? -1 : (beatIndex.get(beatId) ?? Infinity));
  return {
    rankOf: (flag: Flag): Rank => [partRank(flag.partId), barRank(flag.barId), flag.voice ?? "", beatRank("beatId" in flag ? flag.beatId : undefined)],
    /** A cursor in the append slot stands just after its anchor, or before the first beat of an empty voice. */
    rankAt: (cursor: Cursor): Rank => [
      partRank(cursor.partId),
      barRank(cursor.barId),
      cursor.voice,
      cursor.beatId === null ? -0.5 : beatRank(cursor.beatId) + (cursor.at === "after" ? 0.5 : 0),
    ],
  };
}

/** The same fields with the same values: two flags of one kind at one place, two cursors at one place. */
function sameFields<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * Where the cursor goes for a flag: the flag's beat, else the first place of its voice (the first
 * voice when it has none, or one the part does not have), in its bar, else the part's first bar;
 * on the string of its note on a fretted part, else on `line`, else where the part starts. Null
 * when the cursor cannot go there: no part or no bar of the score.
 */
function cursorFor(score: ScoreJSON, flag: Flag, line: number | undefined): Cursor | null {
  const part = score.parts.find((each) => each.id === flag.partId);
  const barId = flag.barId ?? score.bars[0]?.id;
  if (part === undefined || barId === undefined || !score.bars.some((bar) => bar.id === barId)) return null;
  const voice = flag.voice !== undefined && voiceKeys(part.staves.length).includes(flag.voice) ? flag.voice : MAIN_VOICE;
  const beats = part.content[barId]?.[voice] ?? [];
  const beat = beats.find((each) => "beatId" in flag && each.id === flag.beatId) ?? beats[0];
  const string = part.kind === "fretted" && "noteKey" in flag ? /^s(\d+)$/.exec(flag.noteKey ?? "")?.[1] : undefined;
  return {
    partId: part.id,
    barId,
    voice,
    beatId: beat?.id ?? null,
    at: beat === undefined ? "after" : "on",
    line: string === undefined ? (line ?? startLine(part.kind)) : Number(string),
  };
}

/** The flag F8 goes to (docs/spec/flags.md, section 4), and the cursor there. */
export interface FlagStop {
  flag: Flag;
  cursor: Cursor;
}

/** Where F8 stopped is still where the cursor is, and its flag is still there: not moved off, not fixed. */
export function stillAt(stop: FlagStop | null, at: Cursor | null, flags: readonly Flag[]): stop is FlagStop {
  return stop !== null && at !== null && sameFields(stop.cursor, at) && flags.some((flag) => sameFields(flag, stop.flag));
}

export interface NextFlagOptions {
  /** Where F8 last stopped: while the cursor is still there, F8 goes on to the flag after that one, which may be on the same beat. */
  stopped?: FlagStop | null;
  /** The parts shown, the only ones F8 goes to; all of them when left out. */
  partIds?: readonly string[];
}

/**
 * Where F8 goes (docs/spec/flags.md, section 4): the first flag after the cursor in the order of
 * `flags` (`flagsOf`), from the first again after the last; the first when there is no cursor.
 * Only flags the cursor can go to count: in a part shown, in a bar of the score. The cursor keeps
 * its line in its own part. Null when there is no such flag.
 */
export function nextFlag(score: ScoreJSON, flags: readonly Flag[], at: Cursor | null, { stopped = null, partIds }: NextFlagOptions = {}): FlagStop | null {
  const { rankOf, rankAt } = placesIn(score);
  const stops = flags.flatMap((flag) => {
    if (partIds !== undefined && (flag.partId === undefined || !partIds.includes(flag.partId))) return [];
    const cursor = cursorFor(score, flag, at !== null && at.partId === flag.partId ? at.line : undefined);
    return cursor === null ? [] : [{ flag, cursor }];
  });
  if (stops.length === 0) return null;
  const stoppedAt = stopped !== null && at !== null && sameFields(stopped.cursor, at) ? stopped.flag : undefined;
  const index = stoppedAt === undefined ? -1 : stops.findIndex(({ flag }) => sameFields(flag, stoppedAt));
  if (index >= 0) return stops[(index + 1) % stops.length]!;
  if (at === null) return stops[0]!;
  // The flag stopped at is gone (fixed meanwhile): on from where it was.
  const from = stoppedAt === undefined ? rankAt(at) : rankOf(stoppedAt);
  return stops.find(({ flag }) => compareRanks(rankOf(flag), from) > 0) ?? stops[0]!;
}
