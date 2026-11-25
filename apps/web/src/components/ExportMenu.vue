<script setup lang="ts">
// The export menu of a score (docs/spec/import-export.md, section 3): a member downloads it as a
// Guitar Pro 7 or a MIDI file, in any view. A guest has none, which is only the interface: the
// score is in their browser anyway. In the toolbar it opens under its name; in the narrow Read
// view's drawer, which scrolls, the formats are laid out in it instead.
import { AppButton } from "@karyl-chan/ui";
import { ref } from "vue";

import { EXPORT_FORMATS, type ExportFormat } from "../exportFile";
import { strings } from "../strings";

defineProps<{ inline?: boolean }>();
const emit = defineEmits<{ export: [format: ExportFormat] }>();
const text = strings.score.export;
const menu = ref<HTMLDetailsElement>();

function choose(format: ExportFormat): void {
  if (menu.value) menu.value.open = false;
  emit("export", format);
}
</script>

<template>
  <div v-if="inline" class="export export--inline" data-export-menu role="group" :aria-label="text.open">
    <span>{{ text.open }}</span>
    <AppButton v-for="format in EXPORT_FORMATS" :key="format" variant="ghost" size="sm" :data-export="format" @click="choose(format)">
      {{ text.formats[format] }}
    </AppButton>
  </div>
  <details v-else ref="menu" class="export" data-export-menu>
    <summary>{{ text.open }}</summary>
    <div class="export__menu" role="group" :aria-label="text.open">
      <AppButton v-for="format in EXPORT_FORMATS" :key="format" variant="ghost" size="sm" :data-export="format" @click="choose(format)">
        {{ text.formats[format] }}
      </AppButton>
    </div>
  </details>
</template>

<style scoped>
.export {
  position: relative;
  font-size: 0.875rem;
}
.export summary {
  cursor: pointer;
}
.export--inline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}
.export__menu {
  position: absolute;
  z-index: 20;
  top: 100%;
  left: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--space-1);
  margin-top: var(--space-1);
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-base);
  background: var(--bg-page);
  white-space: nowrap;
}
</style>
