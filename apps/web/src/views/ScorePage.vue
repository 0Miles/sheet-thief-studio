<script setup lang="ts">
// A score's page, member's or guest's: the score itself (ScoreView), closed when what the member
// may do with it changed while it was open (docs/spec/collab.md, section 7). It is then opened
// anew, as a new ScoreView with a new document, the old one and what was typed in it dropped; or
// the 404 page takes its place; or /login, the session over.
// A member's versions page (`/scores/:id/versions`) is a page of this one: the score stays open
// under it, hidden, with its document, connection and undo, and a version is restored in that
// document; back on the score, Ctrl+Z undoes the restore (docs/spec/collab.md, 8.5).
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";

import type { Closing, ReadOnlyReason } from "../access";
import type { RestoreTarget } from "../restore";
import { strings } from "../strings";
import { useSessionStore } from "../stores/session";
import NotFoundView from "./NotFoundView.vue";
import ScoreView from "./ScoreView.vue";

const props = defineProps<{ id?: string; token?: string }>();

const route = useRoute();
const router = useRouter();
const session = useSessionStore();
/** How many times the score was opened anew on this page: a new ScoreView each time. */
const opened = ref(0);
/** What the score opened anew says first. */
const notice = ref<string | undefined>();
/** Why the score opened anew is read-only from the start: it was locked on this page (`lockReadOnly`). */
const readOnly = ref<ReadOnlyReason | undefined>();
const removed = ref(false);
/** The score open now: the ScoreView of this time it was opened. */
const scoreView = shallowRef<InstanceType<typeof ScoreView> | null>(null);
/** The versions page is shown, the score under it. */
const aside = computed(() => route.name === "score-versions");

/** What the versions page restores a version in: whichever ScoreView holds the score now. */
const restoreTarget: RestoreTarget = {
  canRestore: () => scoreView.value?.restoreTarget.canRestore() ?? false,
  lockedBecause: () => scoreView.value?.restoreTarget.lockedBecause() ?? null,
  replace: (version) => scoreView.value?.restoreTarget.replace(version) ?? false,
};

// A score opened under the versions page (its address loaded, or the score opened anew there) starts aside.
watch(scoreView, (opened) => {
  if (aside.value) opened?.stepAside();
});

watch(aside, async (now) => {
  if (now) {
    scoreView.value?.stepAside();
    return;
  }
  // Once the score is shown again: a hidden element takes no focus.
  await nextTick();
  scoreView.value?.stepBack();
});

/**
 * The server closed the score's connection for good (its `closed` notice, docs/spec/collab.md,
 * 2.1): no version can be restored in it any more. From the versions page, back to the score,
 * which says why and offers it anew from the server.
 */
async function onStopped(): Promise<void> {
  if (aside.value && props.id !== undefined) await router.replace({ name: "score", params: { id: props.id } });
}

async function onClosed(closing: Closing): Promise<void> {
  if (closing.kind === "reopen") {
    notice.value = closing.notice;
    readOnly.value = closing.readOnly;
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
  <template v-else>
    <div :class="{ 'score-page__behind': aside }" :inert="aside || undefined" :aria-hidden="aside || undefined">
      <ScoreView :key="`${id ?? token}:${opened}`" ref="scoreView" :id="id" :token="token" :notice="notice" :read-only="readOnly" @closed="onClosed" @stopped="onStopped" />
    </div>
    <RouterView v-slot="{ Component }">
      <!-- The score's own child route draws nothing: the score above is the page. -->
      <component :is="Component" v-if="Component && aside" :restore-target="restoreTarget" />
    </RouterView>
  </template>
</template>

<style scoped>
/*
 * Under the versions page: laid out still, as wide as the window, so that the score drawn in it
 * keeps its width; but unseen, out of the keyboard's and the mouse's way.
 */
.score-page__behind {
  position: fixed;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
}
</style>
