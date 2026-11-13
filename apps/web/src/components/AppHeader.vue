<script setup lang="ts">
import { AppButton } from "@karyl-chan/ui";
import { ref } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { strings } from "../strings";
import { useSessionStore } from "../stores/session";

const session = useSessionStore();
const router = useRouter();
const leaving = ref(false);

async function logout(): Promise<void> {
  leaving.value = true;
  try {
    await session.logout();
    await router.push({ name: "login" });
  } finally {
    leaving.value = false;
  }
}
</script>

<template>
  <header class="app-header">
    <RouterLink class="app-header__name" to="/">{{ strings.app.name }}</RouterLink>
    <span class="app-header__account">{{ session.me?.displayName }}</span>
    <AppButton variant="ghost" size="sm" :loading="leaving" @click="logout">{{ strings.header.logout }}</AppButton>
  </header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 1.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
}
.app-header__name {
  margin-right: auto;
  font-weight: 700;
  color: var(--text);
  text-decoration: none;
}
.app-header__account {
  color: var(--text-muted);
}
</style>
