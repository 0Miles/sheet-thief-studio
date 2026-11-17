<script setup lang="ts">
// The member's own playback settings (docs/spec/playback.md, sections 1 and 3): the mute, solo and
// volume of each part, the speed, the loop the selection makes, the metronome, the count-in, and
// what a change does while playing. In a panel at the side of the score, or in the narrow Read
// view's drawer. Each change is the page's to store and to hand to the player.
import { NEUTRAL_MIX, type PartMix } from "@studio/score-render";

import { type PlaybackOptions, type ScoreMix, SPEEDS, VOLUME_STEP, type WhilePlaying } from "../mixer";
import { strings } from "../strings";

defineProps<{
  /** The parts, in score order, and whether each shares its channels with another part. */
  parts: { id: string; name: string; shared: boolean }[];
  mix: ScoreMix;
  playback: PlaybackOptions;
  /** What the loop is, as said; null where there is no selection to make one (the Read view). */
  loop: string | null;
}>();
const emit = defineEmits<{
  part: [partId: string, change: Partial<PartMix>];
  speed: [speed: number];
  playback: [change: Partial<PlaybackOptions>];
}>();
const text = strings.score.mixer;
const MODES: readonly WhilePlaying[] = ["a", "b"];

const checked = (event: Event) => (event.target as HTMLInputElement).checked;
const numberOf = (event: Event) => Number((event.target as HTMLInputElement | HTMLSelectElement).value);
</script>

<template>
  <div class="mixer" data-mixer>
    <ul v-if="parts.length > 0" class="mixer__parts">
      <li v-for="part in parts" :key="part.id" class="mixer__part" data-mix-part :data-part-id="part.id">
        <span class="mixer__name">
          {{ part.name || strings.score.untitled }}
          <span v-if="part.shared" class="mixer__shared" data-shared :title="text.shared">*</span>
        </span>
        <label class="mixer__toggle">
          <input type="checkbox" data-mute :aria-label="text.muteOf(part.name)" :checked="(mix.parts.get(part.id) ?? NEUTRAL_MIX).mute" @change="emit('part', part.id, { mute: checked($event) })" />
          {{ text.mute }}
        </label>
        <label class="mixer__toggle">
          <input type="checkbox" data-solo :aria-label="text.soloOf(part.name)" :checked="(mix.parts.get(part.id) ?? NEUTRAL_MIX).solo" @change="emit('part', part.id, { solo: checked($event) })" />
          {{ text.solo }}
        </label>
        <input
          class="mixer__volume"
          type="range"
          data-volume
          min="0"
          max="1"
          :step="VOLUME_STEP"
          :aria-label="text.volumeOf(part.name)"
          :value="(mix.parts.get(part.id) ?? NEUTRAL_MIX).volume"
          @change="emit('part', part.id, { volume: numberOf($event) })"
        />
        <span class="mixer__value">{{ text.percent((mix.parts.get(part.id) ?? NEUTRAL_MIX).volume) }}</span>
      </li>
    </ul>
    <p v-if="parts.some((part) => part.shared)" class="mixer__note">* {{ text.shared }}</p>
    <label class="mixer__row">
      {{ text.speed }}
      <select data-speed :value="mix.speed" @change="emit('speed', numberOf($event))">
        <option v-for="speed in SPEEDS" :key="speed" :value="speed">{{ text.percent(speed) }}</option>
      </select>
    </label>
    <p v-if="loop !== null" class="mixer__row" data-loop>
      <span>{{ text.loop }}</span>
      <span class="mixer__muted">{{ loop }}</span>
    </p>
    <label class="mixer__row">
      <input type="checkbox" data-metronome :checked="playback.metronome" @change="emit('playback', { metronome: checked($event) })" />
      {{ text.metronome }}
    </label>
    <label class="mixer__row">
      <input type="checkbox" data-count-in :checked="playback.countIn" @change="emit('playback', { countIn: checked($event) })" />
      {{ text.countIn }}
    </label>
    <label class="mixer__row mixer__row--stacked">
      {{ text.whilePlaying }}
      <select data-while-playing :value="playback.whilePlaying" @change="emit('playback', { whilePlaying: ($event.target as HTMLSelectElement).value as WhilePlaying })">
        <option v-for="mode in MODES" :key="mode" :value="mode">{{ text.modes[mode] }}</option>
      </select>
    </label>
  </div>
</template>

<style scoped>
.mixer {
  display: grid;
  gap: 0.75rem;
  font-size: 0.875rem;
}
.mixer__parts {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.mixer__part {
  display: grid;
  grid-template-columns: auto auto 1fr auto;
  align-items: center;
  gap: 0.25rem 0.5rem;
}
.mixer__name {
  grid-column: 1 / -1;
  overflow-wrap: anywhere;
}
.mixer__shared {
  color: var(--text-muted);
}
.mixer__toggle,
.mixer__row {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  margin: 0;
  white-space: nowrap;
}
.mixer__row--stacked {
  flex-direction: column;
  align-items: stretch;
  white-space: normal;
}
.mixer__volume {
  min-width: 0;
}
.mixer__value {
  min-width: 2.75rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.mixer__note,
.mixer__muted {
  margin: 0;
  color: var(--text-muted);
  white-space: normal;
}
</style>
