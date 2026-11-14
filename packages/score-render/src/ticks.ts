// Playback positions and bars: which bar is played at a tick, and at which tick a bar starts. Both
// read the tick lookup alphaTab builds with the sound of a score, so that a bar played twice (a
// repeat) is found where it sounds, not where it is written.
import type * as alphaTab from "@coderline/alphatab";

type MidiTickLookup = alphaTab.midi.MidiTickLookup;
type MasterBarTickLookup = alphaTab.midi.MasterBarTickLookup;

/** A bar of the score by its index, and how many ticks into it. */
export interface PlayedBar {
  index: number;
  offset: number;
}

/** The bar played at a tick: the last one started by then (past the end, the last bar). Null for a score with no bars. */
export function barAtTick(lookup: MidiTickLookup, tick: number): PlayedBar | null {
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

/** The tick a bar is first played at; null when it is not in the sound. */
export function barStartTick(lookup: MidiTickLookup, index: number): number | null {
  return lookup.masterBars.find((played) => played.masterBar.index === index)?.start ?? null;
}
