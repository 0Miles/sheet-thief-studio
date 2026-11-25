<script setup lang="ts">
import { AppButton, Cluster, Spacer } from "@karyl-chan/ui";
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
    <Cluster gap="3" align="center">
      <RouterLink class="app-header__name" to="/">{{ strings.app.name }}</RouterLink>
      <Spacer />
      <!-- Nobody to log out on a page open without logging in (a guest's). -->
      <template v-if="session.me">
        <!-- No way to /account while the password must be changed first. -->
        <span v-if="session.me.mustChangePassword" class="app-header__account">{{ session.me.displayName }}</span>
        <template v-else>
          <RouterLink v-if="session.me.isAdmin" class="app-header__account" :to="{ name: 'admin' }">{{ strings.header.admin }}</RouterLink>
          <RouterLink class="app-header__account" :to="{ name: 'account' }" :title="strings.header.account">{{ session.me.displayName }}</RouterLink>
        </template>
        <AppButton variant="ghost" size="sm" :loading="leaving" @click="logout">{{ strings.header.logout }}</AppButton>
      </template>
    </Cluster>
  </header>
</template>

<style scoped>
.app-header {
  padding: var(--space-2) var(--space-5);
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
}
.app-header__name {
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text-strong);
  text-decoration: none;
  white-space: nowrap;
}
.app-header__account {
  color: var(--text-muted);
  font-size: 0.875rem;
  text-decoration: none;
  white-space: nowrap;
}
a.app-header__account:hover {
  color: var(--text);
  text-decoration: underline;
}
@media (max-width: 767px) {
  .app-header {
    padding: var(--space-2) var(--space-4);
  }
}
</style>
