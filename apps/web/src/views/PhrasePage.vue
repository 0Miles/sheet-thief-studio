<script setup lang="ts">
// A phrase's page: the phrase editor (PhraseView), opened anew, with a new document, when the
// member reloads a phrase changed elsewhere, or when another phrase's address is opened from it
// (a phrase saved as a new one).
import { ref } from "vue";

import PhraseView from "./PhraseView.vue";

defineProps<{ id: string }>();
/** How many times the phrase was opened anew on this page: a new PhraseView each time. */
const opened = ref(0);
</script>

<template>
  <PhraseView :key="`${id}:${opened}`" :id="id" @reload="opened += 1" />
</template>
