<script setup lang="ts">
// The phrase library (docs/spec/phrases.md, section 4): my phrases in one flat list, most recently
// updated first, filtered by kind and searched by name. Making a blank phrase, renaming, copying
// and deleting are for devices that can be typed on only (`canType`); a phone or a tablet lists,
// filters and searches. Every device recognizes images: they are uploaded, and the review page
// opens; the recognitions not yet saved nor discarded are listed above the phrases (待審核).
import { AppButton, AppConfirmDialog, AppModal, AppTextField, Cluster, Stack } from "@karyl-chan/ui";
import {
  createdPhrase,
  createdRecognition,
  duplicatedPhrase,
  type PartKind,
  partKindSchema,
  phraseLimits,
  phraseList,
  phraseRevision,
  type PhraseSummary,
  recognitionLimits,
  type RecognitionList,
  recognitionList,
} from "@studio/contracts";
import { blankFragment, PART_PRESET_IDS, PART_PRESETS, type PartPresetId } from "@studio/score-model";
import { onMounted, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";

import { ApiError, del, get, patchFor, postFor } from "../api";
import AppHeader from "../components/AppHeader.vue";
import { canType } from "../device";
import { uploadForm, uploadRefusal } from "../recognition";
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
onMounted(loadRecognitions);

// Recognizing images ----------------------------------------------------------------------------

const router = useRouter();
/** My recognitions not yet saved nor discarded; null until asked. */
const recognitions = ref<RecognitionList["recognitions"] | null>(null);
const picker = ref<HTMLInputElement>();
const uploading = ref(false);
/** What to say of an upload that did not go; empty while all is well. */
const uploadError = ref("");

async function loadRecognitions(): Promise<void> {
  recognitions.value = (await get("/api/recognitions", recognitionList)).recognitions;
}

/** When a recognition was started, as the list says it. */
function startedAt(createdAt: string): string {
  return new Date(createdAt).toLocaleString("zh-TW", { dateStyle: "short", timeStyle: "short" });
}

/** The images chosen, in their order, sent to be recognized; the review page then follows how it goes. */
async function recognize(): Promise<void> {
  const input = picker.value;
  const files = input?.files ? [...input.files] : [];
  // The same files chosen again are a change too.
  if (input) input.value = "";
  if (files.length === 0) return;
  uploadError.value = "";
  if (files.length > recognitionLimits.images.max) {
    uploadError.value = text.tooManyImages;
    return;
  }
  uploading.value = true;
  try {
    const { id } = await postFor("/api/recognitions", uploadForm(files), createdRecognition);
    await router.push({ name: "recognition", params: { id } });
  } catch (failure) {
    uploadError.value = uploadRefusal(failure);
  } finally {
    uploading.value = false;
  }
}
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
  <main class="phrases page" :data-can-type="editable">
    <Cluster gap="3" align="center" class="phrases__head">
      <h1 class="page-head__title">{{ text.title }}</h1>
      <AppButton variant="secondary" :loading="uploading" :title="text.recognizeHelp" data-recognize @click="picker?.click()">{{ text.recognize }}</AppButton>
      <!-- No capture: a phone offers its camera and its photos alike (docs/spec/phrases.md, section 4). -->
      <input ref="picker" class="phrases__picker" type="file" accept="image/*" multiple tabindex="-1" aria-hidden="true" data-recognize-input @change="recognize" />
      <AppButton v-if="editable" variant="primary" @click="open('create')">{{ text.newPhrase }}</AppButton>
    </Cluster>
    <p v-if="uploadError" class="phrases__error" role="alert" data-upload-error>{{ uploadError }}</p>
    <section v-if="recognitions && recognitions.length > 0" class="phrases__pending" data-pending>
      <h2>{{ text.pending }}</h2>
      <ul class="phrases__list">
        <li v-for="item in recognitions" :key="item.id" class="phrases__item" :data-recognition="item.id">
          <RouterLink class="phrases__name" :to="{ name: 'recognition', params: { id: item.id } }">{{ text.pendingStatus[item.status] }}</RouterLink>
          <span class="phrases__muted">{{ text.pendingItem(item.pages, startedAt(item.createdAt)) }}</span>
        </li>
      </ul>
    </section>
    <Cluster gap="3" align="end" class="phrases__filters">
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
    <p v-else-if="phrases === null" class="state-loading">{{ strings.loading }}</p>
    <p v-else-if="phrases.length === 0" class="state-empty">{{ kind === "" && search.trim() === "" ? text.empty : text.noMatch }}</p>
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
.phrases__head {
  margin-bottom: var(--space-5);
}
.phrases > p {
  margin-top: var(--space-4);
}
.phrases__filters {
  margin-top: var(--space-4);
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
/* One list with hairlines between its rows, not a stack of separate cards. */
.phrases__list {
  list-style: none;
  margin: var(--space-4) 0 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-surface);
  overflow: hidden;
}
.phrases__item {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  align-items: center;
  padding: var(--space-3) var(--space-4);
}
.phrases__item + .phrases__item {
  border-top: 1px solid var(--border);
}
.phrases__name {
  font-weight: 600;
  flex: 1;
  min-width: 8rem;
  overflow-wrap: anywhere;
  color: var(--text);
  text-decoration: none;
}
.phrases__name:hover {
  color: var(--accent-text);
  text-decoration: underline;
}
.phrases__muted {
  color: var(--text-muted);
}
.phrases__error {
  color: var(--danger);
  margin: 0;
}
/* Opened by its button: the picker itself is never seen. */
.phrases__picker {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  opacity: 0;
}
.phrases__pending {
  margin-top: var(--space-5);
}
</style>
