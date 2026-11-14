<script setup lang="ts">
// A box over the score to type a short text in, at a place the page gives (docs/spec/keymap.md,
// section 6): the text of a beat, and later the syllables of the lyrics. Enter saves what is
// typed, Esc leaves without saving, and so does leaving the box; a key with which an input method
// ends a composition (a word chosen with Enter) does neither. Every other key is the box's own:
// none of them reaches the score's keys.
import { textEntryEffectOf } from "@studio/score-editor";
import type { Rect } from "@studio/score-render";
import { onMounted, ref } from "vue";

import { keyPlatform } from "../device";

const props = defineProps<{
  /** Where the box is, on the page of the score. */
  rect: Rect;
  /** What the box holds when it opens. */
  initial: string;
  maxLength: number;
  label: string;
}>();
const emit = defineEmits<{ save: [text: string]; cancel: [] }>();

const input = ref<HTMLInputElement>();
const value = ref(props.initial);
/** Saved or left: a blur that follows is not another way out. */
let closed = false;

function close(then: () => void): void {
  if (closed) return;
  closed = true;
  then();
}

function onKey(event: KeyboardEvent): void {
  // The box's keys, typed letters and digits among them, are not the score's.
  event.stopPropagation();
  const effect = textEntryEffectOf(event, keyPlatform());
  if (effect === null) return;
  event.preventDefault();
  if (effect === "saveEntry") close(() => emit("save", value.value));
  else close(() => emit("cancel"));
}

onMounted(() => {
  input.value?.focus({ preventScroll: true });
  input.value?.select();
});
</script>

<template>
  <input
    ref="input"
    v-model="value"
    class="entry"
    data-text-entry
    type="text"
    :maxlength="maxLength"
    :aria-label="label"
    :style="{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` }"
    @keydown="onKey"
    @pointerdown.stop
    @blur="close(() => emit('cancel'))"
  />
</template>

<style scoped>
.entry {
  position: absolute;
  z-index: 6;
  box-sizing: border-box;
  margin: 0;
  padding: 0 0.375rem;
  border: 1px solid rgba(234, 88, 12, 0.8);
  border-radius: 4px;
  background: #fff;
  color: #000;
  font: inherit;
  font-size: 0.875rem;
}
</style>
