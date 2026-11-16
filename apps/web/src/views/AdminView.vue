<script setup lang="ts">
// The admin's page (docs/spec/accounts.md, section 2): every account, making one, giving one a new
// temporary password, disabling and enabling. The router lets only an admin here; the server
// answers anyone else as if there were no such thing.
import { AppButton, AppConfirmDialog, AppModal, AppTextField, Cluster, Spacer, Stack } from "@karyl-chan/ui";
import { type AdminAccount, adminAccount, adminAccountList, accountLimits, createAccountRequest, password as passwordShape } from "@studio/contracts";
import { onMounted, ref } from "vue";

import { ApiError, get, post, postFor } from "../api";
import AppHeader from "../components/AppHeader.vue";
import { errorText, strings } from "../strings";
import { useSessionStore } from "../stores/session";

const text = strings.admin;
const session = useSessionStore();

const accounts = ref<AdminAccount[] | null>(null);
/** What to say when the list could not be asked for; null while all is well. */
const loadError = ref<string | null>(null);

async function load(): Promise<void> {
  try {
    accounts.value = (await get("/api/admin/accounts", adminAccountList)).accounts;
    loadError.value = null;
  } catch (failure) {
    loadError.value = say(failure);
    // Still an error of the page: it reaches the console, and the e2e tests' pageerror check.
    throw failure;
  }
}

onMounted(load);

function say(failure: unknown): string {
  return failure instanceof ApiError ? errorText(failure.code) : strings.unknownError;
}

// Every dialog of the page: which one is open, on which account, and what it is sending.
type Dialog = "create" | "reset" | "disable";
const dialog = ref<Dialog | null>(null);
const target = ref<AdminAccount | null>(null);
const username = ref("");
const displayName = ref("");
const password = ref("");
const error = ref("");
const sending = ref(false);
/** What was just done, said above the list. */
const done = ref("");

function open(which: Dialog, account: AdminAccount | null = null): void {
  dialog.value = which;
  target.value = account;
  username.value = displayName.value = password.value = error.value = "";
}

function close(): void {
  if (!sending.value) dialog.value = null;
}

/** Do what a dialog or a button asks, then show the list as it now is; a refusal is said in the open dialog, or above the list. */
async function send(action: () => Promise<unknown>, said: string): Promise<void> {
  error.value = done.value = "";
  sending.value = true;
  try {
    await action();
    dialog.value = null;
    done.value = said;
  } catch (failure) {
    error.value = say(failure);
    if (dialog.value === null) throw failure;
  } finally {
    sending.value = false;
  }
  await load();
}

function create(): Promise<void> | void {
  // What the server would refuse anyway, said before asking it.
  const typed = createAccountRequest.safeParse({ username: username.value, displayName: displayName.value, password: password.value });
  if (!typed.success) {
    const field = typed.error.issues[0]?.path[0];
    error.value = field === "username" ? text.rules.username : field === "displayName" ? text.rules.displayName : text.rules.password;
    return;
  }
  return send(() => postFor("/api/admin/accounts", typed.data, adminAccount), text.created(typed.data.username));
}

function reset(): Promise<void> | void {
  if (!passwordShape.safeParse(password.value).success) {
    error.value = text.rules.password;
    return;
  }
  const account = target.value!;
  return send(() => post(`/api/admin/accounts/${account.accountId}/reset-password`, { password: password.value }), text.wasReset(account.username));
}

function disable(): Promise<void> {
  const account = target.value!;
  return send(() => post(`/api/admin/accounts/${account.accountId}/disable`), text.wasDisabled(account.username));
}

function enable(account: AdminAccount): Promise<void> {
  return send(() => post(`/api/admin/accounts/${account.accountId}/enable`), text.wasEnabled(account.username));
}
</script>

<template>
  <AppHeader />
  <main class="admin">
    <Cluster gap="3">
      <h1>{{ text.title }}</h1>
      <Spacer />
      <AppButton variant="primary" @click="open('create')">{{ text.newAccount }}</AppButton>
    </Cluster>
    <!-- A refusal of a button that opens no dialog (enabling). -->
    <p v-if="error && dialog === null" class="admin__error" role="alert">{{ error }}</p>
    <p v-else-if="done" class="admin__muted" role="status">{{ done }}</p>
    <p v-if="loadError" class="admin__error" role="alert">{{ loadError }}</p>
    <p v-else-if="accounts === null" class="admin__muted">{{ strings.loading }}</p>
    <ul v-else class="admin__list" :aria-label="text.accounts">
      <li v-for="account in accounts" :key="account.accountId" class="admin__item" :data-account="account.username" :data-disabled="account.disabled">
        <span class="admin__name">
          <span class="admin__username">{{ account.username }}</span>
          <span>{{ account.displayName }}</span>
        </span>
        <span v-if="account.isAdmin" class="admin__tag">{{ text.isAdmin }}</span>
        <span v-if="account.disabled" class="admin__tag admin__tag--disabled">{{ text.disabled }}</span>
        <!-- One's own password is changed on /account, and nobody disables themselves. -->
        <Cluster v-if="account.accountId !== session.me?.accountId" gap="1" :wrap="false">
          <AppButton variant="ghost" size="sm" @click="open('reset', account)">{{ text.reset }}</AppButton>
          <AppButton v-if="account.disabled" variant="ghost" size="sm" :disabled="sending" @click="enable(account)">{{ text.enable }}</AppButton>
          <AppButton v-else variant="ghost" size="sm" @click="open('disable', account)">{{ text.disable }}</AppButton>
        </Cluster>
      </li>
    </ul>

    <AppModal :visible="dialog === 'create'" :title="text.create.title" :close-label="text.close" @close="close">
      <form novalidate @submit.prevent="create">
        <Stack gap="4">
          <AppTextField v-model="username" :label="text.create.username" name="username" :maxlength="accountLimits.username.max" autocomplete="off" autocapitalize="none" spellcheck="false" autofocus required />
          <p class="admin__muted admin__rule">{{ text.rules.username }}</p>
          <AppTextField v-model="displayName" :label="text.create.displayName" name="display-name" :maxlength="accountLimits.displayName.max" autocomplete="off" required />
          <!-- Shown as typed: the admin hands it over, and there is no second field to catch a slip. -->
          <AppTextField v-model="password" :label="text.create.password" name="initial-password" :maxlength="accountLimits.password.max" autocomplete="off" autocapitalize="none" spellcheck="false" required />
          <p class="admin__muted admin__rule">{{ text.create.help }}</p>
          <p v-if="error" class="admin__error" role="alert">{{ error }}</p>
          <Cluster gap="2" justify="end">
            <AppButton type="button" variant="ghost" @click="close">{{ text.cancel }}</AppButton>
            <AppButton type="submit" variant="primary" :loading="sending">{{ text.create.submit }}</AppButton>
          </Cluster>
        </Stack>
      </form>
    </AppModal>
    <AppModal :visible="dialog === 'reset'" :title="text.resetPassword.title(target?.username ?? '')" :close-label="text.close" @close="close">
      <form novalidate @submit.prevent="reset">
        <Stack gap="4">
          <p class="admin__muted admin__rule">{{ text.resetPassword.help }}</p>
          <AppTextField v-model="password" :label="text.resetPassword.password" name="temporary-password" :maxlength="accountLimits.password.max" autocomplete="off" autocapitalize="none" spellcheck="false" autofocus required />
          <p v-if="error" class="admin__error" role="alert">{{ error }}</p>
          <Cluster gap="2" justify="end">
            <AppButton type="button" variant="ghost" @click="close">{{ text.cancel }}</AppButton>
            <AppButton type="submit" variant="primary" :loading="sending">{{ text.resetPassword.submit }}</AppButton>
          </Cluster>
        </Stack>
      </form>
    </AppModal>
    <AppConfirmDialog
      :visible="dialog === 'disable'"
      :title="text.disableAccount.title"
      :message="text.disableAccount.message(target?.username ?? '')"
      :confirm-label="text.disableAccount.confirm"
      :cancel-label="text.cancel"
      :loading-label="strings.loading"
      confirm-variant="danger"
      :loading="sending"
      :error="error || undefined"
      @close="close"
      @confirm="disable"
    />
  </main>
</template>

<style scoped>
.admin {
  max-width: 48rem;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}
.admin__list {
  list-style: none;
  margin: 1.5rem 0 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}
.admin__item {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  align-items: center;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}
.admin__name {
  flex: 1;
  min-width: 8rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  overflow-wrap: anywhere;
}
.admin__username {
  font-weight: 600;
}
.admin__tag {
  color: var(--text-muted);
}
.admin__tag--disabled {
  color: var(--danger);
}
.admin__muted {
  color: var(--text-muted);
}
.admin__rule {
  margin: 0;
}
.admin__error {
  color: var(--danger);
  margin: 0;
}
</style>
