<script setup lang="ts">
// My scores (docs/spec/routes.md, section 1): the scores I am a member of, most recently updated
// first, and creating a new one in its dialog.
import { AppButton, Cluster, Spacer } from "@karyl-chan/ui";
import { type ScoreSummary, scoreList } from "@studio/contracts";
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";

import { ApiError, get } from "../api";
import AppHeader from "../components/AppHeader.vue";
import NewScoreDialog from "../components/NewScoreDialog.vue";
import { errorText, strings } from "../strings";

const text = strings.home;

const scores = ref<ScoreSummary[] | null>(null);
const creating = ref(false);

/** What to say when the list could not be asked for; null while all is well. */
const loadError = ref<string | null>(null);

onMounted(async () => {
  try {
    scores.value = (await get("/api/scores", scoreList)).scores;
  } catch (failure) {
    loadError.value = failure instanceof ApiError ? errorText(failure.code) : strings.unknownError;
    // Still an error of the page: it reaches the console, and the e2e tests' pageerror check.
    throw failure;
  }
});
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
.home__score:hover {
  background: var(--bg-surface);
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
