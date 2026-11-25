<script setup lang="ts">
// Logging in. On its own, with a username and password; behind the karyl-chan bot, whose proxy
// drops the session cookie, by a link of its `/studio` command, and this page says why the last
// link logged nobody in (docs/spec/karyl-login.md, section 7).
import { AppButton, AppTextField, Stack } from "@karyl-chan/ui";
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { ApiError } from "../api";
import { afterLogin } from "../router";
import { behindBot, type KarylFailure, takeKarylFailure } from "../served";
import { errorText, strings } from "../strings";
import { useSessionStore } from "../stores/session";

const session = useSessionStore();
const route = useRoute();
const router = useRouter();

const username = ref("");
const password = ref("");
const error = ref("");
const sending = ref(false);

const karyl = strings.login.karyl;
const viaBot = behindBot();

function failureText(failure: KarylFailure): string {
  switch (failure.kind) {
    case "unbound":
      return karyl.unbound(failure.discordId);
    case "disabled":
      return karyl.disabled;
    case "rate_limited":
      return karyl.rateLimited;
    case "invalid":
      return karyl.invalid;
  }
}

const linkFailure = takeKarylFailure();
const linkError = linkFailure === null ? "" : failureText(linkFailure);

async function submit(): Promise<void> {
  error.value = "";
  sending.value = true;
  try {
    await session.login({ username: username.value, password: password.value });
    await router.replace(afterLogin(route.query.redirect));
  } catch (failure) {
    error.value = failure instanceof ApiError ? errorText(failure.code) : strings.unknownError;
    password.value = "";
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <main class="login">
    <section v-if="viaBot" class="login__form" data-karyl-login>
      <Stack gap="4">
        <h1 class="login__title">{{ strings.app.name }}</h1>
        <p v-if="session.expired && !linkError" class="login__expired" role="status">{{ strings.login.expired }}</p>
        <p v-if="linkError" class="login__error" role="alert">{{ linkError }}</p>
        <p class="login__karyl">{{ karyl.instructions }}</p>
      </Stack>
    </section>
    <form v-else class="login__form" @submit.prevent="submit">
      <Stack gap="4">
        <h1 class="login__title">{{ strings.app.name }}</h1>
        <p v-if="session.expired" class="login__expired" role="status">{{ strings.login.expired }}</p>
        <AppTextField v-model="username" :label="strings.login.username" name="username" autocomplete="username" autofocus required />
        <AppTextField v-model="password" :label="strings.login.password" name="password" type="password" autocomplete="current-password" required />
        <p v-if="error" class="login__error" role="alert">{{ error }}</p>
        <AppButton type="submit" variant="primary" block :loading="sending">{{ strings.login.submit }}</AppButton>
        <p class="login__help">{{ strings.login.help }}</p>
      </Stack>
    </form>
  </main>
</template>

<style scoped>
.login {
  display: grid;
  place-items: center;
  min-height: 100vh;
  padding: var(--space-5);
  box-sizing: border-box;
}
.login__form {
  width: min(22rem, 100%);
  padding: var(--space-6);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
  box-sizing: border-box;
}
.login__title {
  margin: 0;
  font-size: 1.25rem;
}
.login__expired {
  margin: 0;
  font-size: 0.875rem;
}
.login__error {
  margin: 0;
  color: var(--danger);
}
.login__karyl {
  margin: 0;
}
.login__help {
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-muted);
}
</style>
