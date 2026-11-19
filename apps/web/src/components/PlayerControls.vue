<script setup lang="ts">
// Play or pause (one button), stop, and where playback is (docs/spec/playback.md, 4.1): in the
// toolbar of the score, or in the bar at the bottom of the narrow Read view. When the sound font
// could not be had, the same button asks for it again (#132).
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
const failed = computed(() => props.state === "failed");
</script>

<template>
  <div class="player" :data-player="state">
    <!-- 「播放」「暫停」「重試」: as wide as one another, so the toolbar keeps its width. -->
    <AppButton variant="primary" size="sm" :disabled="!usable && !failed" @click="failed ? emit('retry') : emit('toggle')">
      {{ failed ? text.retry : state === "playing" ? text.pause : text.play }}
    </AppButton>
    <AppButton variant="ghost" size="sm" :disabled="!usable || stopped" @click="emit('stop')">{{ text.stop }}</AppButton>
    <!-- Always there, as wide as the widest of what it says while the score is open: playing,
         pausing and stopping never change the width of the toolbar, which would otherwise wrap
         or unwrap it and move the score under the member's pointer. A sound font that could not
         be had keeps it so too: the notice is no wider, and the retry is the play button's own. -->
    <span class="player__status">
      <span v-if="state === 'loading'">{{ text.loading }}</span>
      <span v-else-if="state === 'failed'">{{ text.failed }}</span>
      <span v-else-if="state === 'unavailable'">{{ text.unavailable }}</span>
      <span v-else-if="bar !== null" data-playing-bar :data-bar="bar">{{ text.bar(bar) }}</span>
    </span>
  </div>
</template>

<style scoped>
.player {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.player__status {
  /* 「音色載入中…」, 「音色載入失敗」 and 「第 1000 小節」, the most bars a score has; the
     unavailable notice, which never changes once shown, may be wider. */
  min-width: 6.5em;
  color: var(--text-muted);
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
