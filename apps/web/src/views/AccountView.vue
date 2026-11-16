<script setup lang="ts">
// One's own account (docs/spec/routes.md, section 1): the display name, the password, and
// logging out of every device.
import { AppButton, AppTextField, Stack } from "@karyl-chan/ui";
import { accountLimits, displayName as displayNameShape } from "@studio/contracts";
import { ref } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { ApiError } from "../api";
import AppHeader from "../components/AppHeader.vue";
import PasswordForm from "../components/PasswordForm.vue";
import { errorText, strings } from "../strings";
import { useSessionStore } from "../stores/session";

const text = strings.account;
const session = useSessionStore();
const router = useRouter();

// The router lets nobody here who is not logged in.
const name = ref(session.me!.displayName);
const nameError = ref("");
const nameSaved = ref(false);
const savingName = ref(false);

const passwordChanged = ref(false);

const leaveError = ref("");
const leaving = ref(false);

function say(failure: unknown): string {
  return failure instanceof ApiError ? errorText(failure.code) : strings.unknownError;
}

async function saveName(): Promise<void> {
  nameError.value = "";
  nameSaved.value = false;
  const typed = displayNameShape.safeParse(name.value);
  if (!typed.success) {
    nameError.value = text.displayName.rule;
    return;
  }
  savingName.value = true;
  try {
    await session.rename(typed.data);
    name.value = session.me!.displayName;
    nameSaved.value = true;
  } catch (failure) {
    nameError.value = say(failure);
  } finally {
    savingName.value = false;
  }
}

async function logoutAll(): Promise<void> {
  leaveError.value = "";
  leaving.value = true;
  try {
    await session.logoutAll();
    await router.push({ name: "login" });
  } catch (failure) {
    leaveError.value = say(failure);
  } finally {
    leaving.value = false;
  }
}
</script>

<template>
  <AppHeader />
  <main v-if="session.me" class="account">
    <RouterLink :to="{ name: 'home' }" class="account__back">{{ text.back }}</RouterLink>
    <h1>{{ text.title }}</h1>
    <p class="account__muted">{{ text.username(session.me.username) }}</p>

    <section class="account__section">
      <h2>{{ text.displayName.title }}</h2>
      <form @submit.prevent="saveName">
        <Stack gap="3">
          <AppTextField v-model="name" :label="text.displayName.label" name="display-name" :maxlength="accountLimits.displayName.max" autocomplete="nickname" required />
          <p v-if="nameError" class="account__error" role="alert">{{ nameError }}</p>
          <p v-else-if="nameSaved" class="account__muted" role="status">{{ text.displayName.saved }}</p>
          <div><AppButton type="submit" variant="primary" :loading="savingName">{{ text.displayName.save }}</AppButton></div>
        </Stack>
      </form>
    </section>

    <section class="account__section">
      <h2>{{ text.password.title }}</h2>
      <p v-if="passwordChanged" class="account__muted" role="status">{{ text.password.changed }}</p>
      <PasswordForm ask-current :submit-label="text.password.submit" @changed="passwordChanged = true" />
    </section>

    <section class="account__section">
      <h2>{{ text.logoutAll.title }}</h2>
      <p class="account__muted">{{ text.logoutAll.help }}</p>
      <p v-if="leaveError" class="account__error" role="alert">{{ leaveError }}</p>
      <AppButton variant="danger" :loading="leaving" @click="logoutAll">{{ text.logoutAll.submit }}</AppButton>
    </section>
  </main>
</template>

<style scoped>
.account {
  max-width: 28rem;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}
.account__back {
  color: var(--accent-text);
}
.account__section {
  margin-top: 2rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}
.account__section h2 {
  font-size: 1.1rem;
}
.account__muted {
  color: var(--text-muted);
}
.account__error {
  margin: 0;
  color: var(--danger);
}
</style>
