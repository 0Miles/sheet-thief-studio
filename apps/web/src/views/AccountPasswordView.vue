<script setup lang="ts">
// Where an account that logged in with a temporary password is held until it has chosen its own
// (docs/spec/routes.md, section 1): the router sends every other page here, and the header still logs out.
import { useRoute, useRouter } from "vue-router";

import { Stack } from "@karyl-chan/ui";

import AppHeader from "../components/AppHeader.vue";
import PasswordForm from "../components/PasswordForm.vue";
import { afterLogin } from "../router";
import { strings } from "../strings";

const text = strings.account.forced;
const route = useRoute();
const router = useRouter();

/** On to the page they were going to before logging in, or `/`. */
function proceed(): Promise<unknown> {
  return router.replace(afterLogin(route.query.redirect));
}
</script>

<template>
  <AppHeader />
  <main class="page page--narrow">
    <Stack gap="5">
      <Stack gap="2">
        <h1>{{ text.title }}</h1>
        <p class="forced__help">{{ text.help }}</p>
      </Stack>
      <PasswordForm :ask-current="false" :submit-label="text.submit" @changed="proceed" />
    </Stack>
  </main>
</template>

<style scoped>
.forced__help {
  color: var(--text-muted);
}
</style>
