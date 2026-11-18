<script setup lang="ts">
// A score's page, member's or guest's: the score itself (ScoreView), closed when what the member
// may do with it changed while it was open (docs/spec/collab.md, section 7). It is then opened
// anew, as a new ScoreView with a new document, the old one and what was typed in it dropped; or
// the 404 page takes its place; or /login, the session over.
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import type { Closing } from "../access";
import { strings } from "../strings";
import { useSessionStore } from "../stores/session";
import NotFoundView from "./NotFoundView.vue";
import ScoreView from "./ScoreView.vue";

defineProps<{ id?: string; token?: string }>();

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
/** How many times the score was opened anew on this page: a new ScoreView each time. */
const opened = ref(0);
/** What the score opened anew says first. */
const notice = ref<string | undefined>();
const removed = ref(false);

async function onClosed(closing: Closing): Promise<void> {
  if (closing.kind === "reopen") {
    notice.value = closing.notice;
    opened.value += 1;
  } else if (closing.kind === "removed") {
    removed.value = true;
  } else {
    session.expire();
    await router.replace({ name: "login", query: { redirect: route.fullPath } });
  }
}
</script>

<template>
  <NotFoundView v-if="removed" :notice="strings.score.removed" />
  <ScoreView v-else :key="`${id ?? token}:${opened}`" :id="id" :token="token" :notice="notice" @closed="onClosed" />
</template>
