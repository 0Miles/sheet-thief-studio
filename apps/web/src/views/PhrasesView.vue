<script setup lang="ts">
// The phrase library (docs/spec/phrases.md, section 4): my phrases in one flat list, most recently
// updated first, filtered by kind and searched by name. Making a blank phrase, renaming, copying
// and deleting are for devices that can be typed on only (`canType`); a phone or a tablet lists,
// filters and searches.
import { AppButton, AppConfirmDialog, AppModal, AppTextField, Cluster, Spacer, Stack } from "@karyl-chan/ui";
import { createdPhrase, duplicatedPhrase, type PartKind, partKindSchema, phraseLimits, phraseList, phraseRevision, type PhraseSummary } from "@studio/contracts";
import { blankFragment, PART_PRESET_IDS, PART_PRESETS, type PartPresetId } from "@studio/score-model";
import { onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";

import { ApiError, del, get, patchFor, postFor } from "../api";
import AppHeader from "../components/AppHeader.vue";
import { canType } from "../device";
import { errorText, strings } from "../strings";

const text = strings.phrases;
const editable = canType();
const KINDS = partKindSchema.options;
/** How long the search waits after the last key before asking. */
const SEARCH_DELAY_MS = 200;

const phrases = ref<PhraseSummary[] | null>(null);
const kind = ref<PartKind | "">("");
const search = ref("");
/** What to say when the list could not be asked for; null while all is well. */
const loadError = ref<string | null>(null);

/** Only the answer to the latest request is shown: an older one may come back after it. */
let asked = 0;

async function load(): Promise<void> {
  const query = new URLSearchParams();
  if (kind.value !== "") query.set("kind", kind.value);
  if (search.value.trim() !== "") query.set("q", search.value.trim());
  const request = ++asked;
  try {
    const list = (await get(`/api/phrases${query.size > 0 ? `?${query}` : ""}`, phraseList)).phrases;
    if (request !== asked) return;
    phrases.value = list;
    loadError.value = null;
  } catch (failure) {
    if (request !== asked) return;
    loadError.value = failure instanceof ApiError ? errorText(failure.code) : strings.unknownError;
    // Still an error of the page: it reaches the console, and the e2e tests' pageerror check.
    throw failure;
  }
}

onMounted(load);
let searching: ReturnType<typeof setTimeout> | undefined;
// A new kind asks at once, for the search as typed so far too: the search's pending ask is not needed.
watch(kind, () => {
  clearTimeout(searching);
  return load();
});
// Only a change of what is searched for: spaces around it are not sent.
watch(
  () => search.value.trim(),
  () => {
    clearTimeout(searching);
    searching = setTimeout(load, SEARCH_DELAY_MS);
  },
);

// Every dialog of the page: which one is open, on which phrase, and what it is sending.
type Dialog = "create" | "rename" | "delete";
const dialog = ref<Dialog | null>(null);
const target = ref<PhraseSummary | null>(null);
const name = ref("");
const preset = ref<PartPresetId>("guitar6");
const error = ref("");
const sending = ref(false);

function open(which: Dialog, phrase: PhraseSummary | null = null): void {
  dialog.value = which;
  target.value = phrase;
  name.value = which === "create" ? strings.newPhrase.defaultName : (phrase?.name ?? "");
  preset.value = "guitar6";
  error.value = "";
}

function close(): void {
  if (!sending.value) dialog.value = null;
}

/** Do what a dialog or a button asks, then show the list as it now is; a refusal is said in the open dialog, or above the list. */
async function send(action: () => Promise<unknown>): Promise<void> {
  error.value = "";
  sending.value = true;
  try {
    await action();
    dialog.value = null;
  } catch (failure) {
    error.value = failure instanceof ApiError ? errorText(failure.code) : strings.unknownError;
    if (dialog.value === null) throw failure;
  } finally {
    sending.value = false;
  }
  await load();
}

function create(): Promise<void> {
  // A blank phrase: one empty bar of 4/4 for the preset chosen (docs/spec/phrases.md, section 3).
  return send(() => postFor("/api/phrases", { name: name.value, fragment: blankFragment(PART_PRESETS[preset.value]) }, createdPhrase));
}

function rename(): Promise<void> {
  // The revision the list shows now: after a refusal the list is asked again, and the next try is made from the latest.
  const phrase = phrases.value?.find((item) => item.id === target.value!.id) ?? target.value!;
  return send(() => patchFor(`/api/phrases/${phrase.id}`, { name: name.value, baseRevision: phrase.revision }, phraseRevision));
}

function duplicate(phrase: PhraseSummary): Promise<void> {
  return send(() => postFor(`/api/phrases/${phrase.id}/duplicate`, undefined, duplicatedPhrase));
}

function remove(): Promise<void> {
  const phrase = target.value!;
  return send(() => del(`/api/phrases/${phrase.id}`));
}
</script>

<template>
  <AppHeader />
  <main class="phrases" :data-can-type="editable">
    <Cluster gap="3">
      <h1>{{ text.title }}</h1>
      <Spacer />
      <AppButton v-if="editable" variant="primary" @click="open('create')">{{ text.newPhrase }}</AppButton>
    </Cluster>
    <Cluster gap="3" class="phrases__filters">
      <label class="phrases__kind">
        <span>{{ text.kind }}</span>
        <select v-model="kind">
          <option value="">{{ text.allKinds }}</option>
          <option v-for="item in KINDS" :key="item" :value="item">{{ text.kinds[item] }}</option>
        </select>
      </label>
      <AppTextField v-model="search" class="phrases__search" :label="text.search" name="q" type="search" :maxlength="phraseLimits.name.max" />
    </Cluster>
    <!-- A refusal of a button that opens no dialog (copying). -->
    <p v-if="error && dialog === null" class="phrases__error" role="alert">{{ error }}</p>
    <p v-if="loadError" class="phrases__error" role="alert">{{ loadError }}</p>
    <p v-else-if="phrases === null" class="phrases__muted">{{ strings.loading }}</p>
    <p v-else-if="phrases.length === 0" class="phrases__muted">{{ kind === "" && search.trim() === "" ? text.empty : text.noMatch }}</p>
    <ul v-else class="phrases__list">
      <li v-for="phrase in phrases" :key="phrase.id" class="phrases__item" :data-phrase="phrase.id">
        <RouterLink class="phrases__name" :to="{ name: 'phrase', params: { id: phrase.id } }">{{ phrase.name }}</RouterLink>
        <span class="phrases__muted">{{ text.details(phrase) }}</span>
        <Cluster v-if="editable" gap="1" :wrap="false">
          <AppButton variant="ghost" size="sm" @click="open('rename', phrase)">{{ text.rename }}</AppButton>
          <AppButton variant="ghost" size="sm" :disabled="sending" @click="duplicate(phrase)">{{ text.duplicate }}</AppButton>
          <AppButton variant="ghost" size="sm" @click="open('delete', phrase)">{{ text.delete }}</AppButton>
        </Cluster>
      </li>
    </ul>

    <template v-if="editable">
      <AppModal :visible="dialog === 'create'" :title="strings.newPhrase.title" :close-label="strings.newPhrase.close" @close="close">
        <form @submit.prevent="create">
          <Stack gap="4">
            <AppTextField v-model="name" :label="strings.newPhrase.name" name="name" :maxlength="phraseLimits.name.max" autofocus required />
            <label class="phrases__preset">
              <span>{{ strings.newPhrase.preset }}</span>
              <select v-model="preset" name="preset">
                <option v-for="item in PART_PRESET_IDS" :key="item" :value="item">{{ strings.presets[item] }}</option>
              </select>
            </label>
            <p v-if="error" class="phrases__error" role="alert">{{ error }}</p>
            <Cluster gap="2" justify="end">
              <AppButton type="button" variant="ghost" @click="close">{{ strings.newPhrase.cancel }}</AppButton>
              <AppButton type="submit" variant="primary" :loading="sending">{{ strings.newPhrase.create }}</AppButton>
            </Cluster>
          </Stack>
        </form>
      </AppModal>
      <AppModal :visible="dialog === 'rename'" :title="strings.renamePhrase.title" :close-label="strings.renamePhrase.close" @close="close">
        <form @submit.prevent="rename">
          <Stack gap="4">
            <AppTextField v-model="name" :label="strings.renamePhrase.name" name="name" :maxlength="phraseLimits.name.max" autofocus required />
            <p v-if="error" class="phrases__error" role="alert">{{ error }}</p>
            <Cluster gap="2" justify="end">
              <AppButton type="button" variant="ghost" @click="close">{{ strings.renamePhrase.cancel }}</AppButton>
              <AppButton type="submit" variant="primary" :loading="sending">{{ strings.renamePhrase.save }}</AppButton>
            </Cluster>
          </Stack>
        </form>
      </AppModal>
      <AppConfirmDialog
        :visible="dialog === 'delete'"
        :title="strings.deletePhrase.title"
        :message="strings.deletePhrase.message(target?.name ?? '')"
        :confirm-label="strings.deletePhrase.confirm"
        :cancel-label="strings.deletePhrase.cancel"
        :loading-label="strings.loading"
        confirm-variant="danger"
        :loading="sending"
        :error="error || undefined"
        @close="close"
        @confirm="remove"
      />
    </template>
  </main>
</template>

<style scoped>
.phrases {
  max-width: 48rem;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}
.phrases__filters {
  margin-top: 1rem;
  align-items: end;
}
.phrases__kind,
.phrases__preset {
  display: grid;
  gap: 0.25rem;
}
.phrases__search {
  flex: 1;
  min-width: 12rem;
}
.phrases__list {
  list-style: none;
  margin: 1.5rem 0 0;
  padding: 0;
  display: grid;
  gap: 0.5rem;
}
.phrases__item {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  align-items: center;
  padding: 0.75rem 1rem;
  border: 1px solid var(--border);
  border-radius: 0.5rem;
}
.phrases__name {
  font-weight: 600;
  flex: 1;
  min-width: 8rem;
  overflow-wrap: anywhere;
}
.phrases__muted {
  color: var(--text-muted);
}
.phrases__error {
  color: var(--danger);
  margin: 0;
}
</style>
