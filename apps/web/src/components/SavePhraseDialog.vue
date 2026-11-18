<script setup lang="ts">
// "存成樂句" (docs/spec/phrases.md, section 3): the bars selected in a score, as they were when the
// member asked, go to their own library under a name they may change first (`POST /api/phrases`).
import { AppButton, AppModal, AppTextField, Cluster, Stack } from "@karyl-chan/ui";
import { phraseLimits } from "@studio/contracts";
import { ref, watch } from "vue";

import { type BarsToSave, defaultPhraseName, saveAsPhrase, saveRefusal } from "../savePhrase";
import { strings } from "../strings";

/** What to save, and the title of the score it is from; null while the dialog is closed. */
const props = defineProps<{ saving: BarsToSave | null; title: string }>();
/** Closed without saving, or saved under this name. */
const emit = defineEmits<{ close: []; saved: [name: string] }>();
const text = strings.savePhrase;

const name = ref("");
const error = ref("");
const sending = ref(false);

watch(
  () => props.saving,
  (saving) => {
    if (saving === null) return;
    name.value = defaultPhraseName(props.title, saving.first, saving.last);
    error.value = "";
  },
  { immediate: true },
);

function close(): void {
  if (!sending.value) emit("close");
}

async function save(): Promise<void> {
  const given = name.value.trim();
  const saving = props.saving;
  if (saving === null || given === "" || sending.value) return;
  error.value = "";
  sending.value = true;
  try {
    await saveAsPhrase(given, saving.fragment);
  } catch (failure) {
    error.value = saveRefusal(failure);
    return;
  } finally {
    sending.value = false;
  }
  emit("saved", given);
}
</script>

<template>
  <AppModal :visible="saving !== null" :title="text.open" :close-label="text.close" @close="close">
    <form @submit.prevent="save">
      <Stack gap="4">
        <AppTextField v-model="name" :label="text.name" name="name" :maxlength="phraseLimits.name.max" autofocus required />
        <p v-if="error" class="save-phrase__error" role="alert">{{ error }}</p>
        <Cluster gap="2" justify="end">
          <AppButton type="button" variant="ghost" @click="close">{{ text.cancel }}</AppButton>
          <AppButton type="submit" variant="primary" :loading="sending">{{ text.save }}</AppButton>
        </Cluster>
      </Stack>
    </form>
  </AppModal>
</template>

<style scoped>
.save-phrase__error {
  margin: 0;
  color: var(--danger);
}
</style>
