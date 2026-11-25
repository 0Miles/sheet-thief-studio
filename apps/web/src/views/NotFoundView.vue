<script setup lang="ts">
import { Stack } from "@karyl-chan/ui";
import { RouterLink } from "vue-router";

import AppHeader from "../components/AppHeader.vue";
import { strings } from "../strings";

/** Why a page that was open is no longer there (a member removed from a score while it was open); none for an address that never was. */
defineProps<{ notice?: string }>();
</script>

<template>
  <AppHeader />
  <main class="page page--narrow not-found">
    <Stack gap="3">
      <h1>{{ strings.notFound.title }}</h1>
      <p v-if="notice" role="status" data-notice>{{ notice }}</p>
      <p class="not-found__message">{{ strings.notFound.message }}</p>
      <RouterLink to="/" class="not-found__home">{{ strings.notFound.home }}</RouterLink>
    </Stack>
  </main>
</template>

<style scoped>
.not-found {
  padding-top: var(--space-8);
}
.not-found__message {
  color: var(--text-muted);
}
.not-found__home {
  align-self: flex-start;
  color: var(--accent-text);
  font-weight: 600;
}
</style>
