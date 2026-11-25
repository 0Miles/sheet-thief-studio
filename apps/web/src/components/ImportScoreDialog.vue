<script setup lang="ts">
// Importing a file as a new score (docs/spec/import-export.md, section 2). The file is read here,
// in the browser, by score-render (alphaTab, loaded only once a file is chosen); what it could not
// convert is listed in the import report before anything is made. Once confirmed, the server
// makes the score from the `ScoreJSON` read, and it opens.
import { AppButton, AppModal, Cluster, Stack } from "@karyl-chan/ui";
import { createdScore } from "@studio/contracts";
import { MAX_IMPORT_FILE_BYTES, type ScoreJSON } from "@studio/score-model";
import type { ImportReportItem } from "@studio/score-render";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";

import { postFor, refusal } from "../api";
import { strings } from "../strings";

/** The file chosen; the dialog is open while there is one. */
const props = defineProps<{ file: File | null }>();
const emit = defineEmits<{ close: [] }>();

const text = strings.importScore;
const router = useRouter();

/** Where reading the file is: under way, failed (with what to say), or read into a score and its report. */
type Reading = { state: "reading" } | { state: "failed"; message: string } | { state: "read"; score: ScoreJSON; report: ImportReportItem[] };

const reading = ref<Reading>({ state: "reading" });
const error = ref("");
const sending = ref(false);
/** Which file is being read: a file chosen while another is still read replaces it. */
let reads = 0;

/** A file as a score: its size checked before it is read (20 MB), then alphaTab reads it. */
async function read(file: File): Promise<Reading> {
  if (file.size > MAX_IMPORT_FILE_BYTES) return { state: "failed", message: text.failures.fileTooLarge };
  const [{ importScore }, bytes] = await Promise.all([import("@studio/score-render"), file.arrayBuffer()]);
  // A name of white space only gives no title: the score is untitled, as one read with none is shown.
  const result = importScore(new Uint8Array(bytes), file.name.trim() === "" ? strings.score.untitled : file.name);
  return result.ok ? { state: "read", score: result.score, report: result.report } : { state: "failed", message: text.failures[result.failure] };
}

watch(
  () => props.file,
  async (file) => {
    error.value = "";
    sending.value = false;
    if (file === null) return;
    const which = ++reads;
    reading.value = { state: "reading" };
    let result: Reading;
    try {
      result = await read(file);
    } catch {
      // The reader could not be loaded (the connection, say): no fault of the file.
      result = { state: "failed", message: strings.unknownError };
    }
    if (which === reads) reading.value = result;
  },
  { immediate: true },
);

const ready = computed(() => (reading.value.state === "read" ? reading.value : null));

async function create(): Promise<void> {
  if (ready.value === null) return;
  error.value = "";
  sending.value = true;
  try {
    const { id } = await postFor("/api/scores/import", { score: ready.value.score }, createdScore);
    await router.push({ name: "score", params: { id } });
  } catch (failure) {
    error.value = refusal(failure);
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <AppModal :visible="file !== null" :title="text.title" :close-label="text.close" @close="emit('close')">
    <Stack gap="4" class="import-score">
      <p v-if="reading.state === 'reading'" class="import-score__muted" role="status">{{ text.reading(file?.name ?? "") }}</p>
      <p v-else-if="reading.state === 'failed'" class="import-score__error" role="alert">{{ reading.message }}</p>
      <template v-else-if="ready">
        <div>
          <p class="import-score__title">{{ ready.score.title }}</p>
          <p v-if="ready.score.artist" class="import-score__muted">{{ ready.score.artist }}</p>
          <p class="import-score__muted" data-import-summary>{{ text.summary(ready.score.parts.length, ready.score.bars.length) }}</p>
        </div>
        <section :aria-label="text.reportTitle">
          <h3 class="import-score__heading">{{ text.reportTitle }}</h3>
          <p v-if="ready.report.length === 0" class="import-score__muted">{{ text.nothingLost }}</p>
          <template v-else>
            <p class="import-score__muted">{{ text.reportHelp }}</p>
            <ul class="import-score__report" data-import-report>
              <li v-for="item in ready.report" :key="item.loss" :data-loss="item.loss">
                <span>{{ text.losses[item.loss] }}</span>
                <span class="import-score__muted">{{ text.times(item.count, item.bars) }}</span>
              </li>
            </ul>
          </template>
        </section>
      </template>
      <p v-if="error" class="import-score__error" role="alert">{{ error }}</p>
      <Cluster gap="2" justify="end">
        <AppButton type="button" variant="ghost" @click="emit('close')">{{ reading.state === "failed" ? text.close : text.cancel }}</AppButton>
        <AppButton v-if="reading.state !== 'failed'" type="button" variant="primary" :loading="sending" :disabled="ready === null" @click="create">{{ text.create }}</AppButton>
      </Cluster>
    </Stack>
  </AppModal>
</template>

<style scoped>
.import-score p {
  margin: 0;
}
.import-score__title {
  font-weight: 600;
}
.import-score__heading {
  font-size: 1rem;
  margin: 0 0 var(--space-1);
}
.import-score__report {
  margin: var(--space-2) 0 0;
  padding-left: 1.25rem;
  display: grid;
  gap: var(--space-1);
}
.import-score__report li {
  overflow-wrap: anywhere;
}
.import-score__report li span + span {
  margin-left: var(--space-2);
}
.import-score__muted {
  color: var(--text-muted);
}
.import-score__error {
  color: var(--danger);
}
</style>
