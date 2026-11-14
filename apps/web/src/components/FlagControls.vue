<script setup lang="ts">
// How many flags the score has, and the button that goes to the next one as F8 does (docs/spec/
// flags.md, section 4; docs/spec/keymap.md, section 7): a Mac's F8 needs Fn. The flag stopped at
// is told in words.
import { AppButton } from "@karyl-chan/ui";
import type { Flag } from "@studio/score-model";

import { strings } from "../strings";

defineProps<{
  count: number;
  /** The view has a cursor to move: the edit views. */
  canGo: boolean;
  /** The key of the button, as this platform names it. */
  shortcut: string;
  /** The kind of the flag the cursor was taken to, while it is still there. */
  stoppedAt: Flag["kind"] | null;
}>();
const emit = defineEmits<{ next: [] }>();
const text = strings.score.flags;
</script>

<template>
  <div class="flags">
    <span class="flags__count" data-flag-count :data-count="count">{{ text.count(count) }}</span>
    <AppButton v-if="canGo" variant="ghost" size="sm" data-next-flag :title="text.nextKey(shortcut)" :disabled="count === 0" @click="emit('next')">
      {{ text.next }}
    </AppButton>
    <span v-if="stoppedAt" class="flags__what" data-flag-stopped :data-kind="stoppedAt">{{ text.kinds[stoppedAt] }}</span>
  </div>
</template>

<style scoped>
.flags {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
}
.flags__count {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.flags__what {
  color: var(--text-muted);
}
</style>
