<script setup lang="ts">
// The box of lyrics mode (docs/spec/keymap.md, 6.2), beside the beat sung, at a place the page
// gives. It stays open from beat to beat: the page hands each key to the editor session with what
// is typed (`EditorSession.pressLyric`), and gives the box the next beat's syllable when it goes on. A key the page
// does not take is the box's own, and none reaches the score's keys. Leaving the box ends lyrics
// mode without saving, as Esc does.
import type { Rect } from "@studio/score-render";
import { nextTick, onMounted, ref, watch } from "vue";

const props = defineProps<{
  /** Where the box is, on the page of the score. */
  rect: Rect;
  /** The syllable the box holds when it opens on a beat; a new beat's when it goes on. */
  initial: string;
  /** Which beat the box is on: when it changes, the box holds that beat's syllable. */
  beatKey: string;
  maxLength: number;
  label: string;
}>();
/** `key`: a key pressed, with what is typed; the page calls `preventDefault` on the keys it takes. `close`: the box was left. */
const emit = defineEmits<{ key: [typed: string, event: KeyboardEvent]; close: [] }>();

const input = ref<HTMLInputElement>();
const value = ref(props.initial);

function onKey(event: KeyboardEvent): void {
  // The box's keys, typed letters and digits among them, are not the score's.
  event.stopPropagation();
  emit("key", value.value, event);
}

/** With what it holds selected: typing replaces it, Backspace empties it. */
function selectAll(): void {
  input.value?.focus({ preventScroll: true });
  input.value?.select();
}

watch(
  () => props.beatKey,
  async () => {
    value.value = props.initial;
    await nextTick();
    selectAll();
  },
);

onMounted(selectAll);
</script>

<template>
  <input
    ref="input"
    v-model="value"
    class="entry"
    data-lyric-entry
    type="text"
    :maxlength="maxLength"
    :aria-label="label"
    :style="{ left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` }"
    @keydown="onKey"
    @pointerdown.stop
    @blur="emit('close')"
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
  border-radius: var(--radius-sm);
  background: var(--text-on-accent);
  color: #000;
  font: inherit;
  font-size: 0.875rem;
}
</style>
