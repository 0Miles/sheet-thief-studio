<script setup lang="ts">
// One's own account (docs/spec/routes.md, section 1): the display name, the password, and
// logging out of every device.
import { AppButton, AppTextField, Stack } from "@karyl-chan/ui";
import { accountLimits, displayName as displayNameShape } from "@studio/contracts";
import { ref } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { refusal } from "../api";
import AppHeader from "../components/AppHeader.vue";
import PasswordForm from "../components/PasswordForm.vue";
import { strings } from "../strings";
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
    nameError.value = refusal(failure);
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
    leaveError.value = refusal(failure);
  } finally {
    leaving.value = false;
  }
}
</script>

<template>
  <AppHeader />
  <main v-if="session.me" class="page page--narrow">
    <Stack gap="6">
      <Stack gap="2">
        <RouterLink :to="{ name: 'home' }" class="page-back">{{ text.back }}</RouterLink>
        <h1>{{ text.title }}</h1>
        <p class="account__muted">{{ text.username(session.me.username) }}</p>
      </Stack>

      <section class="page-section">
        <Stack gap="3">
          <h2>{{ text.displayName.title }}</h2>
          <form @submit.prevent="saveName">
            <Stack gap="3">
              <AppTextField v-model="name" :label="text.displayName.label" name="display-name" :maxlength="accountLimits.displayName.max" autocomplete="nickname" required />
              <p v-if="nameError" class="account__error" role="alert">{{ nameError }}</p>
              <p v-else-if="nameSaved" class="account__muted" role="status">{{ text.displayName.saved }}</p>
              <div><AppButton type="submit" variant="primary" :loading="savingName">{{ text.displayName.save }}</AppButton></div>
            </Stack>
          </form>
        </Stack>
      </section>

      <section class="page-section">
        <Stack gap="3">
          <h2>{{ text.password.title }}</h2>
          <p v-if="passwordChanged" class="account__muted" role="status">{{ text.password.changed }}</p>
          <PasswordForm ask-current :submit-label="text.password.submit" @changed="passwordChanged = true" />
        </Stack>
      </section>

      <section class="page-section">
        <Stack gap="3">
          <h2>{{ text.logoutAll.title }}</h2>
          <p class="account__muted">{{ text.logoutAll.help }}</p>
          <p v-if="leaveError" class="account__error" role="alert">{{ leaveError }}</p>
          <div><AppButton variant="danger" :loading="leaving" @click="logoutAll">{{ text.logoutAll.submit }}</AppButton></div>
        </Stack>
      </section>
    </Stack>
  </main>
</template>

<style scoped>
.account__muted {
  color: var(--text-muted);
}
.account__error {
  color: var(--danger);
}
</style>
