<script setup lang="ts">
// My scores (docs/spec/routes.md, section 1): the scores I am a member of, most recently updated
// first, creating a new one in its dialog or importing a file as one (docs/spec/import-export.md,
// section 2); below them the scores I own and deleted in the
// last 30 days, to restore (docs/spec/accounts.md, section 8), a block nobody else sees.
import { AppButton, Cluster, Stack } from "@karyl-chan/ui";
import { DELETED_SCORE_DAYS, type DeletedScore, deletedScoreList, type ScoreSummary, scoreList } from "@studio/contracts";
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";

import { get, post, refusal } from "../api";
import AppHeader from "../components/AppHeader.vue";
import ImportScoreDialog from "../components/ImportScoreDialog.vue";
import NewScoreDialog from "../components/NewScoreDialog.vue";
import { strings } from "../strings";

const text = strings.home;

const scores = ref<ScoreSummary[] | null>(null);
/** The scores I own and deleted, the last deleted first: empty for anyone who has none. */
const deleted = ref<DeletedScore[]>([]);
/** A restoration is being sent: one at a time. */
const restoring = ref(false);
const creating = ref(false);
/** The file chosen to import; the import dialog is open while there is one. */
const importing = ref<File | null>(null);
const picker = ref<HTMLInputElement | null>(null);

/** The formats alphaTab reads (docs/spec/import-export.md, section 2): Guitar Pro 3 to 8, and MusicXML, compressed too. */
const IMPORT_TYPES = ".gp,.gp3,.gp4,.gp5,.gpx,.musicxml,.xml,.mxl";

/** The file just chosen, to import; the picker is emptied, so that choosing the same file again chooses it anew. */
function chosen(): void {
  const input = picker.value;
  if (input === null) return;
  importing.value = input.files?.[0] ?? null;
  input.value = "";
}

/** What to say when the list could not be asked for; null while all is well. */
const loadError = ref<string | null>(null);

/** What to say when a score could not be restored; null while all is well. */
const restoreError = ref<string | null>(null);


/** Both lists as the server has them now. */
async function load(): Promise<void> {
  const [mine, gone] = await Promise.all([get("/api/scores", scoreList), get("/api/scores/deleted", deletedScoreList)]);
  scores.value = mine.scores;
  deleted.value = gone.scores;
}

onMounted(async () => {
  try {
    await load();
  } catch (failure) {
    loadError.value = refusal(failure);
    // Still an error of the page: it reaches the console, and the e2e tests' pageerror check.
    throw failure;
  }
});

/** The day the score is deleted for good, as the reader's own calendar says it. */
function lastDay(score: DeletedScore): string {
  const day = new Date(score.deletedAt);
  day.setDate(day.getDate() + DELETED_SCORE_DAYS);
  return day.toLocaleDateString("zh-TW");
}

/** Back among my scores; the lists are asked again after a refusal too, which may mean the one shown was no longer the server's. */
async function restore(score: DeletedScore): Promise<void> {
  restoreError.value = null;
  restoring.value = true;
  try {
    await post(`/api/scores/${score.id}/restore`);
  } catch (failure) {
    restoreError.value = refusal(failure);
  }
  try {
    await load();
  } catch (failure) {
    restoreError.value = refusal(failure);
  } finally {
    restoring.value = false;
  }
}
</script>

<template>
  <AppHeader />
  <main class="home page">
    <Stack gap="5">
      <Cluster gap="3" align="center">
        <h1 class="page-head__title">{{ text.title }}</h1>
        <Cluster gap="2" align="center">
          <RouterLink :to="{ name: 'phrases' }" class="home__link">{{ text.phrases }}</RouterLink>
          <AppButton variant="secondary" @click="picker?.click()">{{ text.importScore }}</AppButton>
          <input ref="picker" type="file" :accept="IMPORT_TYPES" :aria-label="text.importFile" hidden @change="chosen" />
          <AppButton variant="primary" @click="creating = true">{{ text.newScore }}</AppButton>
        </Cluster>
      </Cluster>
      <p v-if="loadError" class="home__error" role="alert">{{ loadError }}</p>
      <p v-else-if="scores === null" class="home__muted">{{ strings.loading }}</p>
      <p v-else-if="scores.length === 0" class="home__muted">{{ text.empty }}</p>
      <ul v-else class="home__scores">
        <li v-for="score in scores" :key="score.id">
          <RouterLink :to="{ name: 'score', params: { id: score.id } }" class="home__score">
            <span class="home__title">{{ score.title }}</span>
            <span v-if="score.artist" class="home__muted">{{ score.artist }}</span>
            <span class="home__role">{{ text.roles[score.role] }}</span>
          </RouterLink>
        </li>
      </ul>
      <p v-if="restoreError" class="home__error" role="alert">{{ restoreError }}</p>
      <section v-if="deleted.length > 0" class="page-section" :aria-label="text.deleted.title">
        <Stack gap="3">
          <Stack gap="1">
            <h2>{{ text.deleted.title }}</h2>
            <p class="home__muted">{{ text.deleted.help }}</p>
          </Stack>
          <ul class="home__scores">
            <li v-for="score in deleted" :key="score.id" class="home__score home__score--deleted" :data-deleted="score.id">
              <span class="home__title">{{ score.title }}</span>
              <span v-if="score.artist" class="home__muted">{{ score.artist }}</span>
              <span class="home__muted">{{ text.deleted.until(lastDay(score)) }}</span>
              <AppButton variant="ghost" size="sm" :disabled="restoring" :aria-label="text.deleted.restoreOf(score.title)" @click="restore(score)">{{ text.deleted.restore }}</AppButton>
            </li>
          </ul>
        </Stack>
      </section>
    </Stack>
    <NewScoreDialog :visible="creating" @close="creating = false" />
    <ImportScoreDialog :file="importing" @close="importing = null" />
  </main>
</template>

<style scoped>
/* One list with hairlines between its rows, not a stack of separate cards. */
.home__scores {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
  overflow: hidden;
}
.home__scores > li + li,
.home__scores > .home__score + .home__score {
  border-top: 1px solid var(--border);
}
.home__score {
  display: flex;
  gap: var(--space-2) var(--space-4);
  align-items: baseline;
  padding: var(--space-3) var(--space-4);
  color: var(--text);
  text-decoration: none;
}
a.home__score:hover {
  background: var(--bg-surface-hover);
}
.home__score--deleted {
  flex-wrap: wrap;
  align-items: center;
}
.home__title {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.home__muted {
  color: var(--text-muted);
}
.home__role {
  flex-shrink: 0;
  color: var(--text-muted);
  font-size: 0.875rem;
}
.home__link {
  margin-right: var(--space-2);
  color: var(--accent-text);
  font-weight: 600;
  text-decoration: none;
}
.home__link:hover {
  text-decoration: underline;
}
.home__error {
  color: var(--danger);
}
</style>
