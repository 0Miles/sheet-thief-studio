<script setup lang="ts">
// My scores (docs/spec/routes.md, section 1): the scores I am a member of, most recently updated
// first, and creating a new one. This first version asks only for a title (#11 adds the dialog).
import { AppButton, AppModal, AppTextField, Cluster, Spacer, Stack } from "@karyl-chan/ui";
import { createdScore, type ScoreSummary, scoreList } from "@studio/contracts";
import { onMounted, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { ApiError, get, postFor } from "../api";
import AppHeader from "../components/AppHeader.vue";
import { errorText, strings } from "../strings";

const router = useRouter();
const text = strings.home;

const scores = ref<ScoreSummary[] | null>(null);
const creating = ref(false);
const title = ref("");
const error = ref("");
const sending = ref(false);

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

function startCreating(): void {
  title.value = "";
  error.value = "";
  creating.value = true;
}

async function create(): Promise<void> {
  error.value = "";
  sending.value = true;
  try {
    const { id } = await postFor("/api/scores", { title: title.value }, createdScore);
    await router.push({ name: "score", params: { id } });
  } catch (failure) {
    error.value = failure instanceof ApiError ? errorText(failure.code) : strings.unknownError;
  } finally {
    sending.value = false;
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
      <AppButton variant="primary" @click="startCreating">{{ text.newScore }}</AppButton>
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
    <AppModal :visible="creating" :title="strings.newScore.title" :close-label="strings.newScore.close" @close="creating = false">
      <form @submit.prevent="create">
        <Stack gap="4">
          <AppTextField v-model="title" :label="strings.newScore.scoreTitle" name="title" :maxlength="100" autofocus required />
          <p v-if="error" class="home__error" role="alert">{{ error }}</p>
          <Cluster gap="2" justify="end">
            <AppButton type="button" variant="ghost" @click="creating = false">{{ strings.newScore.cancel }}</AppButton>
            <AppButton type="submit" variant="primary" :loading="sending">{{ strings.newScore.create }}</AppButton>
          </Cluster>
        </Stack>
      </form>
    </AppModal>
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
