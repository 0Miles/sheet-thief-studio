<script setup lang="ts">
// The title and the artist of the score, changed in the title bar of the editable view
// (docs/spec/commands.md, 7.3): each that changed is one command of the session, the page's. The
// title is 1 to 100 characters, the artist up to 100, none when left empty.
// Enter applies (the form's submit); Esc cancels, matched by the keymap's platform layer.
import { AppButton } from "@karyl-chan/ui";
import { type KeyPlatform, textEntryEffectOf } from "@studio/score-editor";
import { MAX_TITLE } from "@studio/score-model";
import { nextTick, onMounted, ref } from "vue";

import { strings } from "../strings";

const props = defineProps<{ platform: KeyPlatform; title: string; artist: string | undefined }>();
const emit = defineEmits<{ apply: [title: string, artist: string]; cancel: [] }>();
const text = strings.score.heading;

const title = ref(props.title);
const artist = ref(props.artist ?? "");
const first = ref<HTMLInputElement>();

function apply(): void {
  const given = title.value.trim();
  if (given !== "") emit("apply", given, artist.value.trim());
}

function onKey(event: KeyboardEvent): void {
  if (textEntryEffectOf(event, props.platform) === "cancelEntry") {
    event.preventDefault();
    emit("cancel");
  }
}

onMounted(() =>
  void nextTick(() => {
    first.value?.focus();
    first.value?.select();
  }),
);
</script>

<template>
  <form class="title-editor" data-title-form :aria-label="text.editTitle" @submit.prevent="apply" @keydown="onKey">
    <label class="title-editor__field">
      <span>{{ text.title }}</span>
      <input ref="first" v-model="title" type="text" name="title" :maxlength="MAX_TITLE" required />
    </label>
    <label class="title-editor__field">
      <span>{{ text.artist }}</span>
      <input v-model="artist" type="text" name="artist" :maxlength="MAX_TITLE" :placeholder="text.artistHelp" />
    </label>
    <AppButton type="submit" variant="primary" size="sm">{{ text.apply }}</AppButton>
    <AppButton type="button" variant="ghost" size="sm" @click="emit('cancel')">{{ text.cancel }}</AppButton>
  </form>
</template>

<style scoped>
.title-editor {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 0.5rem;
}
.title-editor__field {
  display: grid;
  gap: 0.25rem;
  font-size: 0.875rem;
}
</style>
