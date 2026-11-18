<script setup lang="ts">
// The phrase editor's page (`/phrases/:id`; docs/spec/phrases.md, section 5): the phrase read from
// the server and opened in the editor (PhraseEditor). Each change is saved as the whole fragment
// (phraseSaver.ts); a phrase changed elsewhere since is reloaded or saved as a new phrase, never
// merged. Leaving the page sends what is left at once; what cannot be saved is asked about first.
// On a device that cannot be typed on (`canType`), the phrase is only drawn and played, and
// nothing is ever saved.
import { AppButton, AppConfirmDialog, AppModal, AppTextField, Cluster, Stack } from "@karyl-chan/ui";
import { phraseDetails, type PhraseDetails, phraseLimits } from "@studio/contracts";
import type { BarsFragment } from "@studio/score-model";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { onBeforeRouteLeave, onBeforeRouteUpdate, RouterLink, useRouter } from "vue-router";

import { ApiError, get, refusal } from "../api";
import AppHeader from "../components/AppHeader.vue";
import PhraseEditor from "../components/PhraseEditor.vue";
import { canType } from "../device";
import { useLeaveQuestion, warnBeforeUnload } from "../leaving";
import { createPhraseSaver, type PhraseSaver, type SaveState } from "../phraseSaver";
import { errorText, strings } from "../strings";
import NotFoundView from "./NotFoundView.vue";

const props = defineProps<{ id: string }>();
/** The phrase is to be read again from the server, what was changed here dropped: PhrasePage opens it anew. */
const emit = defineEmits<{ reload: [] }>();
const text = strings.phraseEditor;
const router = useRouter();
/** Typed on here; else only drawn and played (docs/spec/phrases.md, section 5). */
const editable = canType();

const notFound = ref(false);
/** What to say when the phrase could not be asked for, for a reason other than not being found; null while all is well. */
const loadError = ref<string | null>(null);
/** The phrase's name, as the page has it. */
const name = ref<string | null>(null);
/** What the editor opens, once read. */
const fragment = shallowRef<BarsFragment | null>(null);
const editor = ref<InstanceType<typeof PhraseEditor>>();
const saveState = ref<SaveState>("saved");
/** While `failed`: tried again by itself, and what the server said when it answered. */
const saveRetrying = ref(false);
const saveError = ref<string | null>(null);

let saver: PhraseSaver | undefined;

/** What the save says when it did not go through and the page cannot do anything about it by itself; null otherwise. */
const saveProblem = computed(() => {
  if (saveState.value === "tooLarge") return errorText("phrase_too_large");
  if (saveState.value === "unchecked") return text.unchecked;
  if (saveState.value !== "failed") return null;
  if (saveRetrying.value) return text.retrying;
  return text.notSaved(saveError.value ?? strings.unknownError);
});
/** The member can ask to try again: what the page will not try again by itself. */
const canRetry = computed(() => saveState.value === "unchecked" || (saveState.value === "failed" && !saveRetrying.value));

function focusScore(): void {
  editor.value?.focus();
}

/** A change in the editor: the whole fragment saved once editing stops. */
function onChange(changed: BarsFragment): void {
  saver?.edit(changed);
}

function retrySave(): void {
  saver?.retry();
  focusScore();
}

// Saving -----------------------------------------------------------------------------------------

type Dialog = "rename" | "saveAsNew";
const dialog = ref<Dialog | null>(null);
const dialogName = ref("");
const dialogError = ref("");
const sending = ref(false);

function openDialog(which: Dialog): void {
  dialog.value = which;
  dialogName.value = name.value ?? "";
  dialogError.value = "";
}

function closeDialog(): void {
  if (sending.value) return;
  dialog.value = null;
  focusScore();
}

/** The new name is saved as the content is, from the revision the page has (docs/spec/phrases.md, 5.1). */
function rename(): void {
  const given = dialogName.value.trim();
  if (saver === undefined || given === "") return;
  name.value = given;
  saver.rename(given);
  closeDialog();
}

/** What is here, as a new phrase: the page then opens it, this one left as the server has it. */
async function saveAsNew(): Promise<void> {
  const given = dialogName.value.trim();
  if (saver === undefined || given === "") return;
  dialogError.value = "";
  sending.value = true;
  let made: string;
  try {
    made = await saver.saveAsNew(given);
  } catch (failure) {
    dialogError.value = refusal(failure);
    return;
  } finally {
    sending.value = false;
  }
  // Nothing of this phrase is to be saved any more: the new one has it.
  saver.destroy();
  saver = undefined;
  dialog.value = null;
  await router.push({ name: "phrase", params: { id: made } });
}

const { leaving, ask } = useLeaveQuestion();

/**
 * Before another page of the app takes this one's place: what waits for its second of quiet, or
 * to be tried again, is sent at once. Leaving waits for it; what cannot be saved (changed
 * elsewhere, too large, out of reach) is asked about first.
 */
async function mayLeave(): Promise<boolean> {
  if (saver === undefined || !saver.unsaved()) return true;
  if (await saver.flush()) return true;
  return ask();
}
onBeforeRouteLeave(mayLeave);
// Another phrase's address (back from a phrase saved as a new one): this one is left too.
onBeforeRouteUpdate((to) => (to.params.id === props.id ? true : mayLeave()));

// Leaving the page itself (closing it, reloading, another site) with changes the server does not
// have: what waits is sent now, and the browser asks first (docs/spec/phrases.md, 5.1).
warnBeforeUnload(() => {
  if (!saver?.unsaved()) return false;
  void saver.flush();
  return true;
});

onMounted(async () => {
  let details: PhraseDetails;
  try {
    details = await get(`/api/phrases/${encodeURIComponent(props.id)}`, phraseDetails);
  } catch (failure) {
    if (failure instanceof ApiError && failure.status === 404) {
      notFound.value = true;
      return;
    }
    loadError.value = refusal(failure);
    // Still an error of the page: it reaches the console, and the e2e tests' pageerror check.
    throw failure;
  }
  name.value = details.name;
  if (editable) {
    const made = createPhraseSaver({ id: details.id, revision: details.revision, name: details.name, fragment: details.fragment });
    saver = made;
    made.onState((state) => {
      saveState.value = state;
      saveRetrying.value = made.retrying;
      saveError.value = made.error === null ? null : errorText(made.error);
    });
  }
  fragment.value = details.fragment;
});

onBeforeUnmount(() => {
  saver?.destroy();
});
</script>

<template>
  <NotFoundView v-if="notFound" />
  <template v-else>
    <AppHeader />
    <PhraseEditor ref="editor" :fragment="fragment" :editable="editable" :desktop-only="text.desktopOnly" @change="onChange">
      <template #lead>
        <RouterLink class="phrase__library" :to="{ name: 'phrases' }">{{ text.library }}</RouterLink>
        <h1 class="phrase__title" data-title>{{ name ?? (loadError ? strings.unknownError : strings.loading) }}</h1>
        <AppButton v-if="editable && name !== null" variant="ghost" size="sm" data-rename @click="openDialog('rename')">{{ text.rename }}</AppButton>
        <span v-if="editable && name !== null" class="phrase__save" :data-save="saveState">{{ text.save[saveState] }}</span>
      </template>
      <template #banners>
        <p v-if="loadError" class="phrase__error" role="alert">{{ loadError }}</p>
        <div v-if="saveState === 'conflict'" class="phrase__banner" role="alert" data-conflict>
          <span>{{ errorText("revision_conflict") }}</span>
          <AppButton variant="ghost" size="sm" data-reload @click="emit('reload')">{{ text.reload }}</AppButton>
          <AppButton variant="primary" size="sm" data-save-as-new @click="openDialog('saveAsNew')">{{ text.saveAsNew }}</AppButton>
        </div>
        <div v-if="saveProblem" class="phrase__banner" role="alert" :data-save-problem="saveState">
          <span>{{ saveProblem }}</span>
          <AppButton v-if="canRetry" variant="ghost" size="sm" data-save-retry @click="retrySave">{{ text.retry }}</AppButton>
        </div>
      </template>
      <template v-if="editable">
        <AppModal :visible="dialog === 'rename'" :title="strings.renamePhrase.title" :close-label="strings.renamePhrase.close" @close="closeDialog">
          <form @submit.prevent="rename">
            <Stack gap="4">
              <AppTextField v-model="dialogName" :label="strings.renamePhrase.name" name="name" :maxlength="phraseLimits.name.max" autofocus required />
              <Cluster gap="2" justify="end">
                <AppButton type="button" variant="ghost" @click="closeDialog">{{ strings.renamePhrase.cancel }}</AppButton>
                <AppButton type="submit" variant="primary">{{ strings.renamePhrase.save }}</AppButton>
              </Cluster>
            </Stack>
          </form>
        </AppModal>
        <AppModal :visible="dialog === 'saveAsNew'" :title="strings.saveAsNewPhrase.title" :close-label="strings.saveAsNewPhrase.close" @close="closeDialog">
          <form @submit.prevent="saveAsNew">
            <Stack gap="4">
              <AppTextField v-model="dialogName" :label="strings.saveAsNewPhrase.name" name="name" :maxlength="phraseLimits.name.max" autofocus required />
              <p v-if="dialogError" class="phrase__error" role="alert">{{ dialogError }}</p>
              <Cluster gap="2" justify="end">
                <AppButton type="button" variant="ghost" @click="closeDialog">{{ strings.saveAsNewPhrase.cancel }}</AppButton>
                <AppButton type="submit" variant="primary" :loading="sending">{{ strings.saveAsNewPhrase.save }}</AppButton>
              </Cluster>
            </Stack>
          </form>
        </AppModal>
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
.phrase__title {
  margin: 0;
  font-size: 1.25rem;
  overflow-wrap: anywhere;
}
.phrase__save {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.875rem;
}
.phrase__error {
  margin: 1rem 1.5rem;
  color: var(--danger);
}
/* Above the phrase, never over it. */
.phrase__banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 0.5rem 1.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--danger);
  font-size: 0.875rem;
}
</style>
