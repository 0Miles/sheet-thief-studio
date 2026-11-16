<script setup lang="ts">
// The panel of the cursor's bar, at the side of the score (docs/spec/commands.md, section 6;
// docs/spec/keymap.md, section 5): its time signature and its tempo, shown and changed there.
// Both are structural: they change the bars of every part. #23 adds the other fields.
// Keys in its fields are theirs; Enter applies a field (the form's submit), Esc and F2 close the
// panel, matched by the keymap's platform layer as every key is.
import { AppButton } from "@karyl-chan/ui";
import { type KeyPlatform, pageEffectOf, textEntryEffectOf } from "@studio/score-editor";
import { barSchema, type TimeSignature, timeSigSchema } from "@studio/score-model";
import { nextTick, onMounted, ref, watch } from "vue";

import { strings } from "../strings";

const props = defineProps<{
  platform: KeyPlatform;
  /** The cursor's bar, counted from 1. */
  bar: number;
  /** The bars a time signature goes to when a selection names them, counted from 1; null without one. */
  range: { first: number; last: number } | null;
  timeSig: TimeSignature;
  /** The tempo written on this bar; undefined when it changes none. */
  tempo: number | undefined;
  /** The tempo in force here, from this bar or one before. */
  tempoInForce: number;
}>();
const emit = defineEmits<{ timeSig: [timeSig: TimeSignature]; tempo: [tempo: number | null]; close: [] }>();
const text = strings.score.bars;

const DENOMINATORS = [...timeSigSchema.shape.denominator.values];
const BEATS = { min: timeSigSchema.shape.numerator.minValue ?? undefined, max: timeSigSchema.shape.numerator.maxValue ?? undefined };
const TEMPO_SCHEMA = barSchema.shape.tempo.unwrap();
const TEMPO = { min: TEMPO_SCHEMA.minValue ?? undefined, max: TEMPO_SCHEMA.maxValue ?? undefined };

const numerator = ref(props.timeSig.numerator);
const denominator = ref<TimeSignature["denominator"]>(props.timeSig.denominator);
const tempo = ref<number | "">(props.tempo ?? "");
const first = ref<HTMLInputElement>();

// The bar's values as they are now: after the cursor moved, or someone changed them.
watch(
  () => [props.timeSig.numerator, props.timeSig.denominator, props.bar] as const,
  ([beats, unit]) => {
    numerator.value = beats;
    denominator.value = unit;
  },
);
watch(
  () => [props.tempo, props.bar] as const,
  ([written]) => {
    tempo.value = written ?? "";
  },
);

function applyTimeSig(): void {
  emit("timeSig", { numerator: numerator.value, denominator: denominator.value });
}

function applyTempo(): void {
  if (tempo.value === "") emit("tempo", null);
  else emit("tempo", tempo.value);
}

function onKey(event: KeyboardEvent): void {
  if (textEntryEffectOf(event, props.platform) === "cancelEntry" || pageEffectOf(event, props.platform) === "barPanel") {
    event.preventDefault();
    emit("close");
  }
}

onMounted(() => void nextTick(() => first.value?.focus()));
</script>

<template>
  <aside class="bar-panel" data-bar-panel :aria-label="text.panel" @keydown="onKey">
    <header class="bar-panel__header">
      <h2 class="bar-panel__title">{{ text.panel }}</h2>
      <AppButton variant="ghost" size="sm" data-close-panel @click="emit('close')">{{ text.close }}</AppButton>
    </header>
    <p class="bar-panel__where" data-panel-bar :data-bar="bar">
      {{ range && range.first !== range.last ? text.range(range.first, range.last) : text.bar(range?.first ?? bar) }}
      <span class="bar-panel__note">{{ text.allParts }}</span>
    </p>
    <form class="bar-panel__group" data-panel-time-sig @submit.prevent="applyTimeSig">
      <h3 class="bar-panel__label">{{ text.timeSig }}</h3>
      <div class="bar-panel__row">
        <label class="bar-panel__field">
          <span>{{ strings.newScore.beats }}</span>
          <input ref="first" v-model.number="numerator" class="bar-panel__number" type="number" name="numerator" :min="BEATS.min" :max="BEATS.max" step="1" required />
        </label>
        <label class="bar-panel__field">
          <span>{{ strings.newScore.beatUnit }}</span>
          <select v-model.number="denominator" name="denominator">
            <option v-for="item in DENOMINATORS" :key="item" :value="item">{{ strings.newScore.beatUnits[item] }}</option>
          </select>
        </label>
      </div>
      <p class="bar-panel__note">{{ range ? text.timeSigRange : text.timeSigOnward }}</p>
      <AppButton type="submit" variant="primary" size="sm">{{ text.apply }}</AppButton>
    </form>
    <form class="bar-panel__group" data-panel-tempo @submit.prevent="applyTempo">
      <label class="bar-panel__field">
        <span>{{ text.tempo }}</span>
        <input v-model.number="tempo" class="bar-panel__number" type="number" name="tempo" :min="TEMPO.min" :max="TEMPO.max" step="any" :placeholder="String(tempoInForce)" />
      </label>
      <p class="bar-panel__note">{{ props.tempo === undefined ? text.tempoInherited(tempoInForce) : text.tempoHere }}</p>
      <div class="bar-panel__row">
        <AppButton type="submit" variant="primary" size="sm">{{ text.apply }}</AppButton>
        <AppButton type="button" variant="ghost" size="sm" data-clear-tempo :disabled="props.tempo === undefined" @click="emit('tempo', null)">{{ text.clearTempo }}</AppButton>
      </div>
    </form>
  </aside>
</template>

<style scoped>
.bar-panel {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  width: 16rem;
  flex: none;
  padding: 0.75rem 1rem;
  border-left: 1px solid var(--border);
  background: var(--bg-surface);
  overflow-y: auto;
}
.bar-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.bar-panel__title {
  margin: 0;
  font-size: 1rem;
}
.bar-panel__where {
  display: grid;
  gap: 0.25rem;
  margin: 0;
  font-weight: 600;
}
.bar-panel__group {
  display: grid;
  gap: 0.5rem;
}
.bar-panel__label {
  margin: 0;
  font-size: 0.875rem;
}
.bar-panel__row {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 0.5rem;
}
.bar-panel__field {
  display: grid;
  gap: 0.25rem;
  font-size: 0.875rem;
}
.bar-panel__number {
  width: 6rem;
}
.bar-panel__note {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.75rem;
  font-weight: normal;
}
</style>
