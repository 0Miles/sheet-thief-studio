<script setup lang="ts">
// Play or pause (one button), stop, and where playback is (docs/spec/playback.md, 4.1): in the
// toolbar of the score, or in the bar at the bottom of the narrow Read view.
import { AppButton } from "@karyl-chan/ui";
import type { PlayerState } from "@studio/score-render";

import { strings } from "../strings";

defineProps<{
  state: PlayerState;
  /** Nothing to stop: never started, or stopped. */
  stopped: boolean;
  /** The bar playback is in, counted from 1; null when none is shown. */
  bar: number | null;
}>();
const emit = defineEmits<{ toggle: []; stop: [] }>();
const text = strings.score.player;
</script>

<template>
  <div class="player" :data-player="state">
    <AppButton variant="primary" size="sm" :disabled="state === 'loading'" @click="emit('toggle')">
      {{ state === "playing" ? text.pause : text.play }}
    </AppButton>
    <AppButton variant="ghost" size="sm" :disabled="state === 'loading' || stopped" @click="emit('stop')">{{ text.stop }}</AppButton>
    <span v-if="state === 'loading'" class="player__playing">{{ text.loading }}</span>
    <span v-else-if="bar !== null" class="player__playing" data-playing-bar :data-bar="bar">{{ text.bar(bar) }}</span>
  </div>
</template>

<style scoped>
.player {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.player__playing {
  color: var(--text-muted);
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
