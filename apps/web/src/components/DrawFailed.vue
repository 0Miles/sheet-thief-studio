<script setup lang="ts">
// The score could not be drawn (#151): the music font, or the worker that lays it out, could not
// be had. Shown where the score would be; the engine asks again by itself once the browser is
// back online, the button asks now (docs/spec/playback.md, 4.1).
import { AppButton } from "@karyl-chan/ui";

import { strings } from "../strings";

const emit = defineEmits<{ retry: [] }>();
const text = strings.score.drawing;
</script>

<template>
  <p class="draw-failed" role="alert" data-draw-failed>
    <span>{{ text.failed }}</span>
    <AppButton variant="ghost" size="sm" data-draw-retry @click="emit('retry')">{{ text.retry }}</AppButton>
  </p>
</template>

<style scoped>
.draw-failed {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 1rem 0;
  color: var(--danger);
}
</style>
