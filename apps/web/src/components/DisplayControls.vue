<script setup lang="ts">
// The member's own display options of a score (docs/spec/views.md, section 6): which parts are
// shown, and the zoom. The narrow Read view picks its one part elsewhere and shows the zoom only.
import { computed } from "vue";

import { SCALES, shownParts } from "../display";
import { strings } from "../strings";

const props = defineProps<{
  /** The parts to choose from, in the score's order; left out, there is no choice of parts. */
  parts?: { id: string; name: string }[];
  hidden: readonly string[];
  scale: number;
}>();
const emit = defineEmits<{ hide: [partId: string, hidden: boolean]; scale: [scale: number] }>();
const text = strings.score.display;

/** The one part still shown cannot be hidden: a score shows at least one. */
const lastShown = computed(() => {
  const shown = shownParts(props.parts?.map((part) => part.id) ?? [], props.hidden);
  return shown.length === 1 ? shown[0]! : null;
});

function onScale(event: Event): void {
  emit("scale", Number((event.target as HTMLSelectElement).value));
}
</script>

<template>
  <div class="display">
    <details v-if="parts" class="display__parts">
      <summary>{{ text.parts }}</summary>
      <fieldset class="display__menu" :aria-label="text.parts">
        <label v-for="part in parts" :key="part.id" class="display__part">
          <input
            type="checkbox"
            :checked="!hidden.includes(part.id)"
            :disabled="part.id === lastShown"
            @change="emit('hide', part.id, !($event.target as HTMLInputElement).checked)"
          />
          {{ part.name }}
        </label>
      </fieldset>
    </details>
    <label class="display__zoom">
      {{ text.zoom }}
      <select :value="scale" @change="onScale">
        <option v-for="option in SCALES" :key="option" :value="option">{{ text.scale(option) }}</option>
      </select>
    </label>
  </div>
</template>

<style scoped>
.display {
  display: flex;
  align-items: center;
  gap: 1rem;
  font-size: 0.875rem;
}
.display__parts {
  position: relative;
}
.display__parts summary {
  cursor: pointer;
}
.display__menu {
  position: absolute;
  z-index: 20;
  top: 100%;
  left: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 10rem;
  margin: 0.25rem 0 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 0.375rem;
  background: var(--bg-page);
}
.display__part,
.display__zoom {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  white-space: nowrap;
}
</style>
