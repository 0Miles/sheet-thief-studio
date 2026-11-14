<script setup lang="ts">
// A score's settings (`/scores/:id/settings`, docs/spec/routes.md, section 1). For now its
// read-only link, which only the Owner sees and manages (docs/spec/accounts.md, section 7); the
// members, the transfer and the deletion come with #13 and #15. Anyone who is not a member sees
// the 404 page.
import { AppButton, AppTextField, Cluster, Stack } from "@karyl-chan/ui";
import { type ScoreDetails, scoreDetails, scoreLink } from "@studio/contracts";
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";

import { ApiError, del, get, postFor } from "../api";
import AppHeader from "../components/AppHeader.vue";
import { errorText, strings } from "../strings";
import NotFoundView from "./NotFoundView.vue";

const props = defineProps<{ id: string }>();
const text = strings.settings;

const details = ref<ScoreDetails | null>(null);
const notFound = ref(false);
/** What to say when something could not be done; null while all is well. */
const error = ref<string | null>(null);
/** The Owner's link token: undefined until known, null when the score has none. */
const token = ref<string | null | undefined>(undefined);
const sending = ref(false);
const copied = ref(false);

const linkPath = computed(() => `/api/scores/${props.id}/link`);
/** The whole address a guest opens. */
const address = computed(() => (token.value ? `${location.origin}/s/${token.value}` : ""));

function failed(failure: unknown): void {
  error.value = failure instanceof ApiError ? errorText(failure.code) : strings.unknownError;
}

onMounted(async () => {
  try {
    details.value = await get(`/api/scores/${props.id}`, scoreDetails);
    if (details.value.role === "owner") token.value = (await get(linkPath.value, scoreLink)).token;
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 404) {
      notFound.value = true;
      return;
    }
    failed(failure);
    // Still an error of the page: it reaches the console, and the e2e tests' pageerror check.
    throw failure;
  }
});

/** Make the link, or make it anew: the old one stops opening the score at once. */
async function makeLink(): Promise<void> {
  error.value = null;
  sending.value = true;
  try {
    token.value = (await postFor(linkPath.value, undefined, scoreLink)).token;
    copied.value = false;
  } catch (failure) {
    failed(failure);
  } finally {
    sending.value = false;
  }
}

async function revoke(): Promise<void> {
  error.value = null;
  sending.value = true;
  try {
    await del(linkPath.value);
    token.value = null;
  } catch (failure) {
    failed(failure);
  } finally {
    sending.value = false;
  }
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(address.value);
    copied.value = true;
  } catch (failure) {
    failed(failure);
  }
}
</script>

<template>
  <NotFoundView v-if="notFound" />
  <template v-else>
    <AppHeader />
    <main class="settings">
      <Stack gap="6">
        <Stack gap="1">
          <RouterLink :to="{ name: 'score', params: { id } }">{{ text.back }}</RouterLink>
          <h1>{{ text.title }}<span v-if="details" class="settings__score">{{ details.title }}</span></h1>
        </Stack>
        <p v-if="error" class="settings__error" role="alert">{{ error }}</p>
        <p v-if="details === null && error === null" class="settings__muted">{{ strings.loading }}</p>
        <section v-if="details?.role === 'owner' && token !== undefined" class="settings__section" :aria-label="text.link.title">
          <Stack gap="3">
            <h2>{{ text.link.title }}</h2>
            <p class="settings__muted">{{ text.link.help }}</p>
            <template v-if="token">
              <AppTextField :model-value="address" :label="text.link.address" readonly full-width />
              <Cluster gap="2">
                <AppButton variant="primary" @click="copy">{{ copied ? text.link.copied : text.link.copy }}</AppButton>
                <AppButton variant="ghost" :loading="sending" @click="makeLink">{{ text.link.remake }}</AppButton>
                <AppButton variant="ghost" :loading="sending" @click="revoke">{{ text.link.revoke }}</AppButton>
              </Cluster>
            </template>
            <template v-else>
              <p>{{ text.link.none }}</p>
              <Cluster gap="2">
                <AppButton variant="primary" :loading="sending" @click="makeLink">{{ text.link.make }}</AppButton>
              </Cluster>
            </template>
          </Stack>
        </section>
      </Stack>
    </main>
  </template>
</template>

<style scoped>
.settings {
  max-width: 40rem;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}
.settings h1,
.settings h2 {
  margin: 0;
}
.settings__score {
  margin-left: 0.75rem;
  color: var(--text-muted);
  font-size: 1rem;
  font-weight: 400;
}
.settings__section {
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}
.settings__muted {
  margin: 0;
  color: var(--text-muted);
}
.settings__error {
  margin: 0;
  color: var(--danger);
}
</style>
