<script setup lang="ts">
// A score's settings (`/scores/:id/settings`, docs/spec/routes.md, section 1). Its members, whom
// every member sees and only the Owner changes: adding by username, roles, removing, and handing
// the score over; an Editor or a Viewer leaves here (docs/spec/accounts.md, sections 3 to 6). Its
// read-only link, which only the Owner sees and manages (section 7). The deletion comes with #15.
// Anyone who is not a member sees the 404 page.
import { AppButton, AppConfirmDialog, AppTextField, Cluster, Stack } from "@karyl-chan/ui";
import { type MemberRole, memberRole, type ScoreDetails, scoreDetails, scoreLink, type ScoreMember, scoreMember, scoreMemberList } from "@studio/contracts";
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { ApiError, del, get, patchFor, post, postFor } from "../api";
import AppHeader from "../components/AppHeader.vue";
import { errorText, strings } from "../strings";
import NotFoundView from "./NotFoundView.vue";

const props = defineProps<{ id: string }>();
const text = strings.settings;

const details = ref<ScoreDetails | null>(null);
const notFound = ref(false);
/** What to say when something could not be done; null while all is well. */
const error = ref<string | null>(null);
/** The Owner's link token: undefined until known (and for anyone else), null when the score has none. */
const token = ref<string | null | undefined>(undefined);
const sending = ref(false);
const copied = ref(false);

const router = useRouter();
const scorePath = `/api/scores/${props.id}`;
const linkPath = `${scorePath}/link`;
const membersPath = `${scorePath}/members`;
const ROLES = memberRole.options;

const isOwner = computed(() => details.value?.role === "owner");
/** The members, the Owner first; null until known. */
const members = ref<ScoreMember[] | null>(null);
// The form that adds a member.
const username = ref("");
const role = ref<MemberRole>("editor");
/** A change of members is being sent: one at a time. */
const changing = ref(false);
// The dialog that asks before a transfer or before leaving, the member it is about, and what it could not do.
const dialog = ref<"transfer" | "leave" | null>(null);
const target = ref<ScoreMember | null>(null);
const dialogError = ref("");
/** The whole address a guest opens. */
const address = computed(() => (token.value ? `${location.origin}/s/${token.value}` : ""));

function failed(failure: unknown): void {
  error.value = failure instanceof ApiError ? errorText(failure.code) : strings.unknownError;
}

/** The score as the server has it now: my role in it, its members, and for its Owner its link. */
async function load(): Promise<void> {
  details.value = await get(scorePath, scoreDetails);
  members.value = (await get(membersPath, scoreMemberList)).members;
  token.value = details.value.role === "owner" ? (await get(linkPath, scoreLink)).token : undefined;
}

onMounted(async () => {
  try {
    await load();
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

/** Ask the server for a link change; the token it leaves the score with. */
async function changeLink(change: () => Promise<string | null>): Promise<void> {
  error.value = null;
  sending.value = true;
  try {
    token.value = await change();
    copied.value = false;
  } catch (failure) {
    failed(failure);
  } finally {
    sending.value = false;
  }
}

/** Make the link, or make it anew: the old one stops opening the score at once. */
const makeLink = () => changeLink(async () => (await postFor(linkPath, undefined, scoreLink)).token);

const revoke = () =>
  changeLink(async () => {
    await del(linkPath);
    return null;
  });

function refusal(failure: unknown): string {
  return failure instanceof ApiError ? errorText(failure.code) : strings.unknownError;
}

/**
 * Send a change of members, then show them as they now are: after a refusal too, which may mean
 * the list shown was no longer the server's. A refusal is said in the open dialog, or above the
 * page. Whether the change was made.
 */
async function change(action: () => Promise<unknown>): Promise<boolean> {
  error.value = null;
  dialogError.value = "";
  changing.value = true;
  let done = false;
  try {
    await action();
    done = true;
    dialog.value = null;
  } catch (failure) {
    if (dialog.value === null) failed(failure);
    else dialogError.value = refusal(failure);
  }
  try {
    await load();
  } catch (failure) {
    // No member any more (removed meanwhile): nothing of the score is left to show.
    if (failure instanceof ApiError && failure.status === 404) notFound.value = true;
    else failed(failure);
  } finally {
    changing.value = false;
  }
  return done;
}

async function add(): Promise<void> {
  if (await change(() => postFor(membersPath, { username: username.value, role: role.value }, scoreMember))) username.value = "";
}

function setRole(member: ScoreMember, event: Event): Promise<boolean> {
  const chosen = memberRole.parse((event.target as HTMLSelectElement).value);
  return change(() => patchFor(`${membersPath}/${member.accountId}`, { role: chosen }, scoreMember));
}

const remove = (member: ScoreMember) => change(() => del(`${membersPath}/${member.accountId}`));

function ask(which: "transfer" | "leave", member: ScoreMember | null = null): void {
  dialog.value = which;
  target.value = member;
  dialogError.value = "";
}

function closeDialog(): void {
  if (!changing.value) dialog.value = null;
}

const transfer = () => change(() => post(`${scorePath}/transfer`, { accountId: target.value!.accountId }));

/** Out of the score: back to my scores, where it no longer is. */
async function leave(): Promise<void> {
  dialogError.value = "";
  changing.value = true;
  try {
    await post(`${scorePath}/leave`);
    await router.push({ name: "home" });
  } catch (failure) {
    dialogError.value = refusal(failure);
  } finally {
    changing.value = false;
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
        <section v-if="details && members" class="settings__section" :aria-label="text.members.title">
          <Stack gap="3">
            <h2>{{ text.members.title }}</h2>
            <ul class="settings__members">
              <li v-for="member in members" :key="member.accountId" class="settings__member" :data-member="member.username" :data-role="member.role">
                <span class="settings__name">
                  <span class="settings__username">{{ member.username }}</span>
                  <span>{{ member.displayName }}</span>
                  <span v-if="member.disabled" class="settings__disabled">{{ text.members.disabled }}</span>
                </span>
                <template v-if="isOwner && member.role !== 'owner'">
                  <select :value="member.role" :aria-label="text.members.roleOf(member.username)" :disabled="changing" @change="setRole(member, $event)">
                    <option v-for="option in ROLES" :key="option" :value="option">{{ strings.home.roles[option] }}</option>
                  </select>
                  <Cluster gap="1" :wrap="false">
                    <!-- Only to someone who can log in (docs/spec/accounts.md, section 5). -->
                    <AppButton v-if="!member.disabled" variant="ghost" size="sm" :disabled="changing" @click="ask('transfer', member)">{{ text.members.transfer.action }}</AppButton>
                    <AppButton variant="ghost" size="sm" :disabled="changing" @click="remove(member)">{{ text.members.remove }}</AppButton>
                  </Cluster>
                </template>
                <span v-else class="settings__muted">{{ strings.home.roles[member.role] }}</span>
              </li>
            </ul>
            <form v-if="isOwner" novalidate @submit.prevent="add">
              <Stack gap="2">
                <p class="settings__muted">{{ text.members.add.help }}</p>
                <Cluster gap="2" align="end">
                  <AppTextField v-model="username" :label="text.members.add.username" name="member-username" :maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false" required />
                  <label class="settings__role">
                    <span>{{ text.members.add.role }}</span>
                    <select v-model="role" name="member-role">
                      <option v-for="option in ROLES" :key="option" :value="option">{{ strings.home.roles[option] }}</option>
                    </select>
                  </label>
                  <AppButton type="submit" variant="primary" :loading="changing && dialog === null" :disabled="username.trim() === ''">{{ text.members.add.submit }}</AppButton>
                </Cluster>
              </Stack>
            </form>
            <Cluster v-else gap="2">
              <AppButton variant="ghost" @click="ask('leave')">{{ text.members.leave.action }}</AppButton>
            </Cluster>
          </Stack>
        </section>
        <section v-if="token !== undefined" class="settings__section" :aria-label="text.link.title">
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
      <AppConfirmDialog
        :visible="dialog === 'transfer'"
        :title="text.members.transfer.title"
        :message="text.members.transfer.message(target?.displayName ?? '')"
        :confirm-label="text.members.transfer.confirm"
        :cancel-label="text.members.cancel"
        :loading-label="strings.loading"
        confirm-variant="danger"
        :loading="changing"
        :error="dialogError || undefined"
        @close="closeDialog"
        @confirm="transfer"
      />
      <AppConfirmDialog
        :visible="dialog === 'leave'"
        :title="text.members.leave.title"
        :message="text.members.leave.message(details?.title ?? '')"
        :confirm-label="text.members.leave.confirm"
        :cancel-label="text.members.cancel"
        :loading-label="strings.loading"
        confirm-variant="danger"
        :loading="changing"
        :error="dialogError || undefined"
        @close="closeDialog"
        @confirm="leave"
      />
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
.settings__members {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}
.settings__member {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  align-items: center;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}
.settings__name {
  flex: 1;
  min-width: 8rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  overflow-wrap: anywhere;
}
.settings__username {
  font-weight: 600;
}
.settings__disabled {
  color: var(--danger);
}
.settings__role {
  display: grid;
  gap: 0.25rem;
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
