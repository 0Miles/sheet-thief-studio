<script setup lang="ts">
// Play or pause (one button), stop, and where playback is (docs/spec/playback.md, 4.1): in the
// toolbar of the score, or in the bar at the bottom of the narrow Read view.
import { AppButton } from "@karyl-chan/ui";
import { type PlayerState, playerUsable } from "@studio/score-render";
import { computed } from "vue";

import { strings } from "../strings";

const props = defineProps<{
  state: PlayerState;
  /** Nothing to stop: never started, or stopped. */
  stopped: boolean;
  /** The bar playback is in, counted from 1; null when none is shown. */
  bar: number | null;
}>();
const emit = defineEmits<{ toggle: []; stop: []; retry: [] }>();
const text = strings.score.player;
const usable = computed(() => playerUsable(props.state));
</script>

<template>
  <div class="player" :data-player="state">
    <AppButton variant="primary" size="sm" :disabled="!usable" @click="emit('toggle')">
      {{ state === "playing" ? text.pause : text.play }}
    </AppButton>
    <AppButton variant="ghost" size="sm" :disabled="!usable || stopped" @click="emit('stop')">{{ text.stop }}</AppButton>
    <span v-if="state === 'loading'" class="player__status">{{ text.loading }}</span>
    <template v-else-if="state === 'failed'">
      <span class="player__status">{{ text.failed }}</span>
      <AppButton variant="ghost" size="sm" data-retry-sound @click="emit('retry')">{{ text.retry }}</AppButton>
    </template>
    <span v-else-if="state === 'unavailable'" class="player__status">{{ text.unavailable }}</span>
    <span v-else-if="bar !== null" class="player__status" data-playing-bar :data-bar="bar">{{ text.bar(bar) }}</span>
  </div>
</template>

<style scoped>
.player {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.player__status {
  color: var(--text-muted);
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
