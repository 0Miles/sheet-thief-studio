// The MIDI channels each part plays on (docs/spec/playback.md, section 5). A pure function of the
// kinds of the parts in score order, and nothing else: every member co-editing a score works out
// the same channels from the same document.
import type { PartKind } from "@studio/score-model";

/** The MIDI channel every percussion part plays on (the tenth, counting from 1). */
export const PERCUSSION_CHANNEL = 9;

/** The channels a part plays on: its notes on the primary, a bent note on the secondary (alphaTab). */
export interface PartChannels {
  primary: number;
  secondary: number;
}

/** The 16 channels of MIDI, 0-15, but the one of the drums. */
const OWN_CHANNELS: readonly number[] = Array.from({ length: 16 }, (_, channel) => channel).filter((channel) => channel !== PERCUSSION_CHANNEL);

/**
 * The channels of each part, in the order given:
 * 1. each part that is not drums takes a primary channel of its own, in part order, 9 left out;
 * 2. the channels left over go as secondaries, in part order;
 * 3. a part left without one uses its primary as its secondary;
 * 4. drums play on 9, both channels.
 * Parts past the fifteenth that is not drums (two members adding parts at once go over the limit,
 * no command can stop that) share the channels of the fifteenth, 15 and 15: sounds share a channel
 * and its program, mute and solo, but nothing throws.
 */
export function channelsOf(kinds: readonly PartKind[]): PartChannels[] {
  const own = kinds.filter((kind) => kind !== "percussion").length;
  const taken = Math.min(own, OWN_CHANNELS.length);
  const spare = OWN_CHANNELS.slice(taken);
  const last = OWN_CHANNELS[OWN_CHANNELS.length - 1] as number;
  let index = 0;
  return kinds.map((kind) => {
    if (kind === "percussion") return { primary: PERCUSSION_CHANNEL, secondary: PERCUSSION_CHANNEL };
    const primary = OWN_CHANNELS[index] ?? last;
    const secondary = spare[index] ?? primary;
    index += 1;
    return { primary, secondary };
  });
}
