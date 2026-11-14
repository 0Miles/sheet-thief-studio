<script setup lang="ts">
// The dialog of a new score (docs/spec/commands.md, section 10): its title, its parts (presets,
// each as many times as wanted, fretted ones with a tuning), its time signature and its tempo.
// The server makes the content from what is chosen here; once made, the score opens.
import { AppButton, AppModal, AppTextField, Cluster, Stack } from "@karyl-chan/ui";
import { choicesWithinPartLimits, createdScore, type PartChoice } from "@studio/contracts";
import {
  barSchema,
  MAX_PARTS,
  MAX_TITLE,
  NEW_SCORE,
  PART_PRESET_IDS,
  PART_PRESETS,
  type PartPresetId,
  pitchName,
  type TimeSignature,
  timeSigSchema,
  TUNING_OPTIONS,
  type TuningOption,
  tuningFor,
} from "@studio/score-model";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";

import { ApiError, postFor } from "../api";
import { errorText, strings } from "../strings";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ close: [] }>();

const text = strings.newScore;
const TUNINGS = [...TUNING_OPTIONS, "custom"] as const;
const DENOMINATORS = [...timeSigSchema.shape.denominator.values];
/** The ranges of the schema (docs/spec/schema.md, section 3), for the fields of numbers. */
const range = (schema: { minValue: number | null; maxValue: number | null }) => ({ min: schema.minValue ?? undefined, max: schema.maxValue ?? undefined });
const BEATS = range(timeSigSchema.shape.numerator);
const TEMPO = range(barSchema.shape.tempo.unwrap());
/** Every MIDI pitch a string of a custom tuning can be set to, with its name. */
const PITCHES = Array.from({ length: 128 }, (_, pitch) => ({ pitch, name: pitchName(pitch) }));

/** One line of the parts: a preset, how many parts of it, and for fretted ones their tuning. */
interface PartRow {
  key: number;
  preset: PartPresetId;
  count: number;
  tuning: TuningOption | "custom";
  /** The pitches of a custom tuning, from the first string. */
  custom: number[];
}

const router = useRouter();
let rowKeys = 0;

function newRow(preset: PartPresetId = NEW_SCORE.part): PartRow {
  return { key: rowKeys++, preset, count: 1, tuning: "standard", custom: [...PART_PRESETS[preset].tuning] };
}

const title = ref("");
const rows = ref<PartRow[]>([]);
const numerator = ref(NEW_SCORE.timeSig.numerator);
const denominator = ref<TimeSignature["denominator"]>(NEW_SCORE.timeSig.denominator);
const tempo = ref(NEW_SCORE.tempo);
const error = ref("");
const sending = ref(false);

// Opened afresh each time, with the defaults.
watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    title.value = "";
    rows.value = [newRow()];
    numerator.value = NEW_SCORE.timeSig.numerator;
    denominator.value = NEW_SCORE.timeSig.denominator;
    tempo.value = NEW_SCORE.tempo;
    error.value = "";
  },
  { immediate: true },
);

function isFretted(row: PartRow): boolean {
  return PART_PRESETS[row.preset].kind === "fretted";
}

/** Another preset starts over from its own standard tuning. */
function choosePreset(row: PartRow): void {
  row.tuning = "standard";
  row.custom = [...PART_PRESETS[row.preset].tuning];
}

/** The tuning a part of this row is made with; left out for the preset's own. */
function tuningOf(row: PartRow): number[] | undefined {
  if (!isFretted(row) || row.tuning === "standard") return undefined;
  return row.tuning === "custom" ? [...row.custom] : tuningFor(row.tuning, row.custom.length);
}

/** The parts the score is made with, a line of the dialog each. */
const parts = computed<PartChoice[]>(() => rows.value.map((row) => ({ preset: row.preset, count: row.count, tuning: tuningOf(row) })));
const tooMany = computed(() => !choicesWithinPartLimits(parts.value));

async function create(): Promise<void> {
  error.value = "";
  sending.value = true;
  try {
    const timeSig = { numerator: numerator.value, denominator: denominator.value };
    const { id } = await postFor("/api/scores", { title: title.value, parts: parts.value, timeSig, tempo: tempo.value }, createdScore);
    await router.push({ name: "score", params: { id } });
  } catch (failure) {
    error.value = failure instanceof ApiError ? errorText(failure.code) : strings.unknownError;
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <AppModal :visible="visible" :title="text.title" :close-label="text.close" @close="emit('close')">
    <form @submit.prevent="create">
      <Stack gap="4">
        <AppTextField v-model="title" :label="text.scoreTitle" name="title" :maxlength="MAX_TITLE" autofocus required />
        <fieldset class="new-score__group">
          <legend>{{ text.parts }}</legend>
          <Stack gap="3">
            <div v-for="row in rows" :key="row.key" class="new-score__row" data-part-row>
              <Cluster gap="2" align="end">
                <label class="new-score__field">
                  <span>{{ text.preset }}</span>
                  <select v-model="row.preset" name="preset" @change="choosePreset(row)">
                    <option v-for="item in PART_PRESET_IDS" :key="item" :value="item">{{ strings.presets[item] }}</option>
                  </select>
                </label>
                <label class="new-score__field">
                  <span>{{ text.count }}</span>
                  <input v-model.number="row.count" class="new-score__number" type="number" name="count" min="1" :max="MAX_PARTS" step="1" required />
                </label>
                <label v-if="isFretted(row)" class="new-score__field">
                  <span>{{ text.tuning }}</span>
                  <select v-model="row.tuning" name="tuning">
                    <option v-for="item in TUNINGS" :key="item" :value="item">{{ text.tunings[item] }}</option>
                  </select>
                </label>
                <AppButton v-if="rows.length > 1" type="button" variant="ghost" size="sm" @click="rows = rows.filter((other) => other !== row)">{{ text.removePart }}</AppButton>
              </Cluster>
              <Cluster v-if="isFretted(row) && row.tuning === 'custom'" gap="2" class="new-score__strings">
                <label v-for="(_, index) in row.custom" :key="index" class="new-score__field">
                  <span>{{ text.string(index + 1) }}</span>
                  <select v-model.number="row.custom[index]" :name="`string-${index + 1}`">
                    <option v-for="{ pitch, name } in PITCHES" :key="pitch" :value="pitch">{{ name }}</option>
                  </select>
                </label>
              </Cluster>
            </div>
            <div>
              <AppButton type="button" variant="ghost" size="sm" @click="rows.push(newRow())">{{ text.addPart }}</AppButton>
            </div>
            <p v-if="tooMany" class="new-score__error" role="alert">{{ text.tooManyParts }}</p>
          </Stack>
        </fieldset>
        <Cluster gap="2" align="end">
          <label class="new-score__field">
            <span>{{ text.beats }}</span>
            <input v-model.number="numerator" class="new-score__number" type="number" name="numerator" :min="BEATS.min" :max="BEATS.max" step="1" required />
          </label>
          <label class="new-score__field">
            <span>{{ text.beatUnit }}</span>
            <select v-model.number="denominator" name="denominator">
              <option v-for="item in DENOMINATORS" :key="item" :value="item">{{ text.beatUnits[item] }}</option>
            </select>
          </label>
          <label class="new-score__field">
            <span>{{ text.tempo }}</span>
            <input v-model.number="tempo" class="new-score__number" type="number" name="tempo" :min="TEMPO.min" :max="TEMPO.max" step="any" required />
          </label>
        </Cluster>
        <p v-if="error" class="new-score__error" role="alert">{{ error }}</p>
        <Cluster gap="2" justify="end">
          <AppButton type="button" variant="ghost" @click="emit('close')">{{ text.cancel }}</AppButton>
          <AppButton type="submit" variant="primary" :loading="sending" :disabled="tooMany">{{ text.create }}</AppButton>
        </Cluster>
      </Stack>
    </form>
  </AppModal>
</template>

<style scoped>
.new-score__group {
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  margin: 0;
  padding: 0.75rem 1rem 1rem;
}
.new-score__row + .new-score__row {
  border-top: 1px solid var(--border);
  padding-top: 0.75rem;
}
.new-score__strings {
  margin-top: 0.5rem;
}
.new-score__field {
  display: grid;
  gap: 0.25rem;
}
.new-score__number {
  width: 6rem;
}
.new-score__error {
  color: var(--danger);
  margin: 0;
}
</style>
