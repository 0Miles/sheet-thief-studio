<script setup lang="ts">
// The review page of a recognition (`/recognitions/:id`; docs/spec/phrases.md, section 7): while it
// runs, its progress, polled every 2 seconds; when it failed, why and what to try; when it
// succeeded, the phrase editor opened on its result, beside the images it was read from and what
// was left out of it. A tuning not understood is warned of, and chosen by hand in the editor's
// panel of the part. Changes are not saved by themselves: 「存成樂句」 writes them into the
// library and deletes the recognition with its images; 「捨棄」 deletes them. Leaving with changes
// asks first.
// On a device that cannot be typed on (`canType`), everything is shown and the result plays, but
// nothing changes it: no saving, no discarding, no tuning chosen (left for a computer).
import { AppButton, AppConfirmDialog, AppModal, AppTextField, Cluster, Stack } from "@karyl-chan/ui";
import { type RecognitionDetails, recognitionDetails, phraseLimits, savedRecognition } from "@studio/contracts";
import type { BarsFragment } from "@studio/score-model";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { onBeforeRouteLeave, RouterLink, useRouter } from "vue-router";

import { ApiError, del, get, postFor, refusal } from "../api";
import AppHeader from "../components/AppHeader.vue";
import PhraseEditor from "../components/PhraseEditor.vue";
import { canType } from "../device";
import { useLeaveQuestion, warnBeforeUnload } from "../leaving";
import { defaultRecognitionName, failureOf, pollRecognition, tuningNote } from "../recognition";
import { strings } from "../strings";
import NotFoundView from "./NotFoundView.vue";

const props = defineProps<{ id: string }>();
const text = strings.recognition;
const router = useRouter();
/** Reviewed and saved here; else only looked at and played. */
const editable = canType();

const notFound = ref(false);
/** What to say when the recognition could not be asked for; null while all is well. */
const loadError = ref<string | null>(null);
const details = shallowRef<RecognitionDetails | null>(null);
/** What the editor opens: the result as recognized. */
const fragment = shallowRef<BarsFragment | null>(null);
const editor = ref<InstanceType<typeof PhraseEditor>>();

/** The result as it is now, edited or not; what 「存成樂句」 sends. */
let current: BarsFragment | null = null;
/** Changed since it was opened, and not saved as a phrase nor discarded. */
const edited = ref(false);
/** Saved or discarded: the page is left without asking. */
let done = false;

const pages = computed(() => Array.from({ length: details.value?.pages ?? 0 }, (_, index) => index + 1));
const failure = computed(() => (details.value?.status === "failed" ? failureOf(details.value.error) : null));
const report = computed(() => (details.value?.status === "succeeded" ? details.value.report : null));
const tuning = computed(() => (report.value === null ? null : tuningNote(report.value)));

function onRead(read: RecognitionDetails): void {
  loadError.value = null;
  details.value = read;
  if (read.status === "succeeded" && fragment.value === null) {
    current = read.fragment;
    fragment.value = read.fragment;
  }
}

function onFailure(failed: unknown): void {
  if (failed instanceof ApiError && failed.status === 404) {
    notFound.value = true;
    return;
  }
  // Asked again 2 seconds later; what is wrong is said meanwhile.
  loadError.value = refusal(failed);
}

function onChange(changed: BarsFragment): void {
  current = changed;
  edited.value = true;
}

function chooseTuning(): void {
  editor.value?.openParts();
}

// Saving and discarding --------------------------------------------------------------------------

type Dialog = "save" | "discard";
const dialog = ref<Dialog | null>(null);
const dialogName = ref("");
const dialogError = ref("");
const sending = ref(false);

function openDialog(which: Dialog): void {
  dialog.value = which;
  dialogError.value = "";
  if (which === "save" && details.value !== null) dialogName.value = defaultRecognitionName(details.value.createdAt);
}

function closeDialog(): void {
  if (sending.value) return;
  dialog.value = null;
  editor.value?.focus();
}

/** Send what the dialog asks, then go to the library, where the phrase now is or the recognition no longer is. */
async function send(action: () => Promise<unknown>): Promise<void> {
  dialogError.value = "";
  sending.value = true;
  try {
    await action();
  } catch (failed) {
    dialogError.value = refusal(failed);
    return;
  } finally {
    sending.value = false;
  }
  done = true;
  dialog.value = null;
  await router.push({ name: "phrases" });
}

function save(): Promise<void> {
  const name = dialogName.value.trim();
  if (current === null || name === "") return Promise.resolve();
  const sent = current;
  return send(() => postFor(`/api/recognitions/${encodeURIComponent(props.id)}/save`, { name, fragment: sent }, savedRecognition));
}

function discard(): Promise<void> {
  return send(() => del(`/api/recognitions/${encodeURIComponent(props.id)}`));
}

// Leaving ----------------------------------------------------------------------------------------

/** Changes that leaving would lose. */
const losesChanges = () => !done && edited.value;
const { leaving, ask } = useLeaveQuestion();
onBeforeRouteLeave(() => (losesChanges() ? ask() : true));
// Closing or reloading the page with changes: the browser asks first (docs/spec/phrases.md, section 7).
warnBeforeUnload(losesChanges);

let stopPolling: (() => void) | undefined;
onMounted(() => {
  stopPolling = pollRecognition(() => get(`/api/recognitions/${encodeURIComponent(props.id)}`, recognitionDetails), onRead, onFailure);
});

onBeforeUnmount(() => {
  stopPolling?.();
});
</script>

<template>
  <NotFoundView v-if="notFound" />
  <template v-else>
    <AppHeader />
    <PhraseEditor ref="editor" :fragment="fragment" :editable="editable" :desktop-only="text.desktopOnly" :data-status="details?.status ?? 'loading'" @change="onChange">
      <template #lead>
        <RouterLink :to="{ name: 'phrases' }">{{ text.library }}</RouterLink>
        <h1 class="review__title">{{ text.title }}</h1>
        <span v-if="editable && edited" class="review__muted" data-edited>{{ text.edited }}</span>
      </template>
      <template #trail>
        <Cluster v-if="editable && details !== null && details.status !== 'running'" gap="2" :wrap="false">
          <AppButton v-if="details.status === 'succeeded'" variant="primary" size="sm" data-save-phrase @click="openDialog('save')">{{ text.save }}</AppButton>
          <AppButton variant="ghost" size="sm" data-discard @click="openDialog('discard')">{{ text.discard }}</AppButton>
        </Cluster>
        <p v-if="!editable && details !== null && details.status !== 'succeeded'" class="review__muted" data-desktop-only>{{ text.desktopOnly }}</p>
      </template>
      <template #banners>
        <p v-if="loadError" class="review__banner review__banner--danger" role="alert">{{ loadError }}</p>
        <p v-if="details === null && loadError === null" class="review__banner">{{ strings.loading }}</p>
        <p v-else-if="details?.status === 'running'" class="review__banner" role="status" data-running>{{ text.running }}</p>
        <div v-else-if="failure" class="review__banner review__banner--danger" role="alert" data-failed>
          <strong>{{ text.failed(failure.reason) }}</strong>
          <ul v-if="failure.pages.length > 0" class="review__list">
            <li v-for="line in failure.pages" :key="line">{{ line }}</li>
          </ul>
          <span>{{ failure.advice }}</span>
        </div>
        <div v-if="tuning" class="review__banner" :class="{ 'review__banner--warning': tuning.warning }" :role="tuning.warning ? 'alert' : undefined" :data-tuning-note="tuning.warning ? 'warning' : 'note'">
          <span>{{ tuning.text }}</span>
          <AppButton v-if="editable && tuning.warning" variant="ghost" size="sm" data-choose-tuning @click="chooseTuning">{{ text.chooseTuning }}</AppButton>
        </div>
      </template>
      <template #aside>
        <aside class="review__aside" data-review-aside>
          <section v-if="report" data-skipped>
            <h2 class="review__heading">{{ text.skippedTitle }}</h2>
            <ul v-if="report.skipped.length > 0" class="review__list">
              <li v-for="(item, index) in report.skipped" :key="index" :data-skipped-item="item.code">{{ text.skipped(item) }}</li>
            </ul>
            <p v-else class="review__muted">{{ text.noneSkipped }}</p>
          </section>
          <section v-if="report && report.warnings.length > 0" data-warnings>
            <h2 class="review__heading">{{ text.warningsTitle }}</h2>
            <ul class="review__list">
              <li v-for="(item, index) in report.warnings" :key="index">{{ text.warning(item) }}</li>
            </ul>
          </section>
          <section v-if="pages.length > 0" data-images>
            <h2 class="review__heading">{{ text.images }}</h2>
            <img v-for="page in pages" :key="page" class="review__image" :src="`/api/recognitions/${encodeURIComponent(id)}/images/${page}`" :alt="text.imageAlt(page)" data-original />
          </section>
        </aside>
      </template>
      <template v-if="editable">
        <AppModal :visible="dialog === 'save'" :title="text.saveDialog.title" :close-label="text.saveDialog.close" @close="closeDialog">
          <form @submit.prevent="save">
            <Stack gap="4">
              <AppTextField v-model="dialogName" :label="text.saveDialog.name" name="name" :maxlength="phraseLimits.name.max" autofocus required />
              <p v-if="dialogError" class="review__error" role="alert">{{ dialogError }}</p>
              <Cluster gap="2" justify="end">
                <AppButton type="button" variant="ghost" @click="closeDialog">{{ text.saveDialog.cancel }}</AppButton>
                <AppButton type="submit" variant="primary" :loading="sending">{{ text.saveDialog.save }}</AppButton>
              </Cluster>
            </Stack>
          </form>
        </AppModal>
        <AppConfirmDialog
          :visible="dialog === 'discard'"
          :title="text.discardDialog.title"
          :message="text.discardDialog.message"
          :confirm-label="text.discardDialog.confirm"
          :cancel-label="text.discardDialog.cancel"
          :loading-label="strings.loading"
          confirm-variant="danger"
          :loading="sending"
          :error="dialogError || undefined"
          data-confirm-discard
          @close="closeDialog"
          @confirm="discard"
        />
        <AppConfirmDialog
          :visible="leaving !== null"
          :title="text.leave.title"
          :message="text.leave.message"
          :confirm-label="text.leave.confirm"
          :cancel-label="text.leave.cancel"
          :loading-label="strings.loading"
          confirm-variant="danger"
          data-confirm-leave
          @close="leaving?.(false)"
          @confirm="leaving?.(true)"
        />
      </template>
    </PhraseEditor>
  </template>
</template>

<style scoped>
.review__title {
  margin: 0;
  font-size: 1.25rem;
}
.review__muted {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.875rem;
}
/* Above the result, never over it. */
.review__banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 0.5rem 1.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
  font-size: 0.875rem;
}
.review__banner--danger {
  color: var(--danger);
}
.review__banner--warning {
  color: var(--warning, var(--danger));
}
.review__list {
  margin: 0;
  padding-left: 1.25rem;
  width: 100%;
}
.review__error {
  margin: 0;
  color: var(--danger);
}
/* Beside the result: what was left out, and the images it was read from. */
.review__aside {
  display: grid;
  align-content: start;
  gap: 1rem;
  width: min(28rem, 40%);
  padding: 1rem;
  overflow: auto;
  border-left: 1px solid var(--border);
}
.review__heading {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}
.review__image {
  display: block;
  max-width: 100%;
  height: auto;
  margin-bottom: 0.5rem;
  border: 1px solid var(--border);
}
/* A phone: the images under the result, not beside it. */
@media (max-width: 767px) {
  .review__aside {
    width: auto;
    max-height: 45%;
    border-left: none;
    border-top: 1px solid var(--border);
  }
}
</style>
