<script setup lang="ts">
import { AppButton, AppTextField, Stack } from "@karyl-chan/ui";
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { ApiError } from "../api";
import { afterLogin } from "../router";
import { strings } from "../strings";
import { useSessionStore } from "../stores/session";

const session = useSessionStore();
const route = useRoute();
const router = useRouter();

const username = ref("");
const password = ref("");
const error = ref("");
const sending = ref(false);

async function submit(): Promise<void> {
  error.value = "";
  sending.value = true;
  try {
    await session.login({ username: username.value, password: password.value });
    await router.replace(afterLogin(route.query.redirect));
  } catch (failure) {
    const code = failure instanceof ApiError ? failure.code : "unknown";
    error.value = strings.errors[code] ?? strings.errors.unknown!;
    password.value = "";
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <main class="login">
    <form class="login__form" @submit.prevent="submit">
      <Stack gap="4">
        <h1 class="login__title">{{ strings.app.name }}</h1>
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
  padding: 1.5rem;
  box-sizing: border-box;
}
.login__form {
  width: min(22rem, 100%);
  padding: 2rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-md, 0.5rem);
  background: var(--bg-surface);
  box-sizing: border-box;
}
.login__title {
  margin: 0;
  font-size: 1.25rem;
}
.login__error {
  margin: 0;
  color: var(--danger);
}
.login__help {
  margin: 0;
  font-size: 0.8rem;
  color: var(--text-muted);
}
</style>
