<script setup lang="ts">
// My scores (docs/spec/routes.md, section 1): the scores I am a member of, most recently updated
// first, and creating a new one in its dialog; below them the scores I own and deleted in the
// last 30 days, to restore (docs/spec/accounts.md, section 8), a block nobody else sees.
import { AppButton, Cluster, Spacer } from "@karyl-chan/ui";
import { DELETED_SCORE_DAYS, type DeletedScore, deletedScoreList, type ScoreSummary, scoreList } from "@studio/contracts";
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";

import { get, post, refusal } from "../api";
import AppHeader from "../components/AppHeader.vue";
import NewScoreDialog from "../components/NewScoreDialog.vue";
import { strings } from "../strings";

const text = strings.home;

const scores = ref<ScoreSummary[] | null>(null);
/** The scores I own and deleted, the last deleted first: empty for anyone who has none. */
const deleted = ref<DeletedScore[]>([]);
/** A restoration is being sent: one at a time. */
const restoring = ref(false);
const creating = ref(false);

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
  <main class="home">
    <Cluster gap="3">
      <h1>{{ text.title }}</h1>
      <Spacer />
      <RouterLink :to="{ name: 'phrases' }" class="home__link">{{ text.phrases }}</RouterLink>
      <AppButton variant="primary" @click="creating = true">{{ text.newScore }}</AppButton>
    </Cluster>
    <p v-if="loadError" class="home__error" role="alert">{{ loadError }}</p>
    <p v-else-if="scores === null" class="home__muted">{{ strings.loading }}</p>
    <p v-else-if="scores.length === 0" class="home__muted">{{ text.empty }}</p>
    <ul v-else class="home__scores">
      <li v-for="score in scores" :key="score.id">
        <RouterLink :to="{ name: 'score', params: { id: score.id } }" class="home__score">
          <span class="home__title">{{ score.title }}</span>
          <span v-if="score.artist" class="home__muted">{{ score.artist }}</span>
          <span class="home__muted">{{ text.roles[score.role] }}</span>
        </RouterLink>
      </li>
    </ul>
    <p v-if="restoreError" class="home__error home__restore-error" role="alert">{{ restoreError }}</p>
    <section v-if="deleted.length > 0" class="home__deleted" :aria-label="text.deleted.title">
      <h2>{{ text.deleted.title }}</h2>
      <p class="home__muted">{{ text.deleted.help }}</p>
      <ul class="home__scores">
        <li v-for="score in deleted" :key="score.id" class="home__score" :data-deleted="score.id">
          <span class="home__title">{{ score.title }}</span>
          <span v-if="score.artist" class="home__muted">{{ score.artist }}</span>
          <span class="home__muted">{{ text.deleted.until(lastDay(score)) }}</span>
          <AppButton variant="ghost" size="sm" :disabled="restoring" :aria-label="text.deleted.restoreOf(score.title)" @click="restore(score)">{{ text.deleted.restore }}</AppButton>
        </li>
      </ul>
    </section>
    <NewScoreDialog :visible="creating" @close="creating = false" />
  </main>
</template>

<style scoped>
.home {
  max-width: 40rem;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}
.home__scores {
  list-style: none;
  margin: 1.5rem 0 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}
.home__score {
  display: flex;
  gap: 1rem;
  align-items: baseline;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  color: var(--text);
  text-decoration: none;
}
a.home__score:hover {
  background: var(--bg-surface);
}
.home__deleted {
  margin-top: 2.5rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}
.home__restore-error {
  margin-top: 1.5rem;
}
.home__deleted h2,
.home__deleted p {
  margin: 0;
}
.home__deleted .home__scores {
  margin-top: 1rem;
}
.home__deleted .home__score {
  flex-wrap: wrap;
  align-items: center;
}
.home__title {
  font-weight: 600;
  flex: 1;
}
.home__muted {
  color: var(--text-muted);
}
.home__link {
  color: var(--accent-text);
}
.home__error {
  color: var(--danger);
  margin: 0;
}
</style>
