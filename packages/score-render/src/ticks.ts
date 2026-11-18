// Playback positions and bars: which bar is played at a tick. It reads the tick lookup alphaTab
// builds with the sound of a score, so that a bar played twice (a repeat) is found where it
// sounds, not where it is written. (The tick a bar starts at is alphaTab's `getMasterBarStart`.)
import type * as alphaTab from "@coderline/alphatab";

type MidiTickLookup = alphaTab.midi.MidiTickLookup;
type MasterBarTickLookup = alphaTab.midi.MasterBarTickLookup;

/** A bar of the score by its index, and how many ticks into it. */
export interface TickInBar {
  index: number;
  offset: number;
}

/** The bar played at a tick: the last one started by then (past the end, the last bar). Null for a score with no bars. */
export function barAtTick(lookup: MidiTickLookup, tick: number): TickInBar | null {
  const bars = lookup.masterBars;
  // The played bars are sorted by time: the last one starting at or before the tick.
  let low = 0;
  let high = bars.length - 1;
  if (high < 0) return null;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((bars[middle] as MasterBarTickLookup).start <= tick) low = middle;
    else high = middle - 1;
  }
  const played = bars[low] as MasterBarTickLookup;
  return { index: played.masterBar.index, offset: Math.max(tick - played.start, 0) };
}

/** A place in the music: a bar by its index, which time it is played (0 the first), and how many ticks into it. */
export interface PlayedPlace {
  index: number;
  pass: number;
  offset: number;
}

/** The place played at a tick; null for a score with no bars. */
export function placeAtTick(lookup: MidiTickLookup, tick: number): PlayedPlace | null {
  const bars = lookup.masterBars;
  let played = -1;
  for (let at = 0; at < bars.length && (bars[at] as MasterBarTickLookup).start <= tick; at++) played = at;
  if (played < 0) played = bars.length > 0 ? 0 : -1;
  const lookupAt = bars[played];
  if (lookupAt === undefined) return null;
  const index = lookupAt.masterBar.index;
  const pass = bars.slice(0, played).filter((bar) => bar.masterBar.index === index).length;
  return { index, pass, offset: Math.max(tick - lookupAt.start, 0) };
}

/**
 * The tick of a place in another lookup (of a score changed since): the same pass of the bar, or
 * its last one when it is played fewer times now; no further into it than it lasts. Null when the
 * bar is not played at all.
 */
export function tickAtPlace(lookup: MidiTickLookup, place: PlayedPlace): number | null {
  const passes = lookup.masterBars.filter((bar) => bar.masterBar.index === place.index);
  const played = passes[Math.min(place.pass, passes.length - 1)];
  if (played === undefined) return null;
  return played.start + Math.min(place.offset, Math.max(played.end - played.start - 1, 0));
}
