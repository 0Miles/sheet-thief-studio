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

/** A member's mix of one part (docs/spec/playback.md, section 1): 0 is silent, 1 the volume written in the score. */
export interface PartMix {
  mute: boolean;
  solo: boolean;
  volume: number;
}

/** A part the member did not touch: heard, not alone, at the volume of the score. */
export const NEUTRAL_MIX: Readonly<PartMix> = { mute: false, solo: false, volume: 1 };

/**
 * The mix each channel in use plays with, from the mixes of the parts on it (`channels` and
 * `mixes` in the same order). Parts sharing a channel cannot be told apart there: it is muted
 * when any of them is, played alone when any of them is, and as loud as the quietest of them.
 * Order does not matter, so that it is the same whichever part was changed last.
 */
export function channelMixOf(channels: readonly PartChannels[], mixes: readonly PartMix[]): Map<number, PartMix> {
  const byChannel = new Map<number, PartMix>();
  channels.forEach((part, index) => {
    const mix = mixes[index] ?? NEUTRAL_MIX;
    for (const channel of new Set([part.primary, part.secondary])) {
      const before = byChannel.get(channel);
      byChannel.set(
        channel,
        before === undefined ? { ...mix } : { mute: before.mute || mix.mute, solo: before.solo || mix.solo, volume: Math.min(before.volume, mix.volume) },
      );
    }
  });
  return byChannel;
}

/**
 * Whether each part shares a channel with another part, in the order given: its mute, solo and
 * volume reach that part too. Always so for two drum parts (both on 9), and for parts past the
 * fifteenth that is not drums.
 */
export function sharesChannels(kinds: readonly PartKind[]): boolean[] {
  const channels = channelsOf(kinds);
  const users = new Map<number, number>();
  for (const part of channels) for (const channel of new Set([part.primary, part.secondary])) users.set(channel, (users.get(channel) ?? 0) + 1);
  return channels.map((part) => (users.get(part.primary) ?? 0) > 1 || (users.get(part.secondary) ?? 0) > 1);
}
