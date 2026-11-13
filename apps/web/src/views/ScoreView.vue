<script setup lang="ts">
// A score (`/scores/:id`): opened on /collab and drawn read-only. M1a only shows it; typing
// comes with the edit view in M1b. Anyone who is not a member sees the 404 page.
import { HocuspocusProvider } from "@hocuspocus/provider";
import { collabTicket, type ScoreDetails, scoreDetails } from "@studio/contracts";
import { docToJson, flagsOf, observeScore, type ScoreChange, type ScoreJSON } from "@studio/score-model";
import { createAlphaTabEngine, type ScoreEngine } from "@studio/score-render";
import { onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import * as Y from "yjs";

import { ApiError, get, postFor } from "../api";
import AppHeader from "../components/AppHeader.vue";
import { strings } from "../strings";
import { exposeForTests } from "../testHook";
import NotFoundView from "./NotFoundView.vue";

const props = defineProps<{ id: string }>();
const text = strings.score;

const details = ref<ScoreDetails | null>(null);
const notFound = ref(false);
/** The score is drawn: e2e tests wait for `data-ready` (docs/spec/testing.md, section 2). */
const ready = ref(false);
const sync = ref<"syncing" | "synced" | "offline">("syncing");
const host = ref<HTMLElement>();
const score = shallowRef<ScoreJSON | null>(null);

const doc = new Y.Doc();
let engine: ScoreEngine | undefined;
let provider: HocuspocusProvider | undefined;
let stopObserving: (() => void) | undefined;
const hideFromTests = exposeForTests({
  scoreJson: () => (provider?.isSynced ? docToJson(doc) : null),
  cursor: () => null,
  flags: () => (score.value ? flagsOf(score.value) : []),
});

function draw(change: ScoreChange): void {
  if (engine === undefined) return;
  const json = docToJson(doc);
  score.value = json;
  if (change.kind === "structure") engine.renderer.setScore(json);
  else engine.renderer.patchBars(json, [...change.barIds]);
}

function start(): void {
  if (stopObserving !== undefined || engine === undefined) return;
  draw({ kind: "structure" });
  stopObserving = observeScore(doc, draw);
}

onMounted(async () => {
  try {
    details.value = await get(`/api/scores/${props.id}`, scoreDetails);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      notFound.value = true;
      return;
    }
    throw error;
  }
  if (host.value === undefined) return;
  engine = createAlphaTabEngine(host.value, { fontDirectory: "/font/", soundFont: null });
  engine.renderer.onRendered(() => {
    ready.value = true;
  });
  provider = new HocuspocusProvider({
    url: `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/collab`,
    name: props.id,
    document: doc,
    // A function, so that every connection, reconnections included, shows a new ticket (ADR 0005).
    token: async () => (await postFor(`/api/scores/${props.id}/collab-ticket`, undefined, collabTicket)).ticket,
    onSynced: () => {
      sync.value = "synced";
      start();
    },
    onStatus: ({ status }) => {
      if (status === "disconnected") sync.value = "offline";
      else if (status === "connecting") sync.value = "syncing";
    },
  });
});

onBeforeUnmount(() => {
  hideFromTests();
  stopObserving?.();
  provider?.destroy();
  engine?.destroy();
  doc.destroy();
});
</script>

<template>
  <NotFoundView v-if="notFound" />
  <template v-else>
    <AppHeader />
    <main class="score">
      <header class="score__toolbar">
        <h1 class="score__title">{{ score?.title ?? details?.title ?? strings.loading }}</h1>
        <span class="score__sync" :data-sync="sync">{{ text.sync[sync] }}</span>
      </header>
      <div class="score__scroller">
        <div ref="host" class="score__page" :aria-label="text.label" :data-ready="ready"></div>
      </div>
    </main>
  </template>
</template>

<style scoped>
.score {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 3rem);
}
.score__toolbar {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  padding: 0.5rem 1.5rem;
  border-bottom: 1px solid var(--border);
}
.score__title {
  margin: 0;
  font-size: 1.25rem;
}
.score__sync {
  color: var(--text-muted);
  font-size: 0.875rem;
}
.score__sync[data-sync="offline"] {
  color: var(--danger);
}
.score__scroller {
  flex: 1;
  overflow: auto;
  /* The score is drawn in black: keep its page white in either theme. */
  background: #fff;
}
</style>
