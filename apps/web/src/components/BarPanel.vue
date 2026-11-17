<script setup lang="ts">
// The panel of the cursor's bar, at the side of the score (docs/spec/commands.md, section 6;
// docs/spec/keymap.md, section 5): its time signature, tempo, key, section, repeat, voltas and,
// on the first bar, the pickup, shown and changed there. All are structural: they change the bars
// of every part.
// Keys in its fields are theirs; Enter applies a field (the form's submit), Esc and F2 close the
// panel, matched by the keymap's platform layer as every key is.
import { AppButton } from "@karyl-chan/ui";
import { type KeyPlatform, pageEffectOf, textEntryEffectOf } from "@studio/score-editor";
import { barSchema, type KeySignature, keySigSchema, type RepeatChange, type TimeSignature, timeSigSchema } from "@studio/score-model";
import { computed, nextTick, onMounted, ref, watch } from "vue";

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
  /** The key written on this bar; undefined when it changes none. */
  keySig: KeySignature | undefined;
  /** The key in force here, from this bar or one before. */
  keySigInForce: KeySignature;
  /** The name of the section that starts at this bar. */
  section: string | undefined;
  /** Whether a repeat starts on the bar a repeat set here would start on: the selection's first, else this one. */
  repeatStart: boolean;
  /** How many times in all a repeat ending on the bar a repeat set here would end on (the selection's last, else this one) is played. */
  repeatEnd: number | undefined;
  /** The passes this bar is played on; empty on every pass. */
  voltas: readonly number[];
  /** How many times in all the repeat voltas set here belong to is played (`voltaRepeatTimes`): a pass past it never sounds. */
  voltaRepeatTimes: number;
  /** This bar is the first: only it can be a pickup bar. */
  firstBar: boolean;
  anacrusis: boolean;
}>();
const emit = defineEmits<{
  timeSig: [timeSig: TimeSignature];
  tempo: [tempo: number | null];
  keySig: [keySig: KeySignature | null];
  section: [section: string | null];
  repeat: [change: RepeatChange];
  voltas: [passes: number[]];
  anacrusis: [];
  close: [];
}>();
const text = strings.score.bars;

const DENOMINATORS = [...timeSigSchema.shape.denominator.values];
const BEATS = { min: timeSigSchema.shape.numerator.minValue ?? undefined, max: timeSigSchema.shape.numerator.maxValue ?? undefined };
const TEMPO_SCHEMA = barSchema.shape.tempo.unwrap();
const TEMPO = { min: TEMPO_SCHEMA.minValue ?? undefined, max: TEMPO_SCHEMA.maxValue ?? undefined };
const FIFTHS_SCHEMA = keySigSchema.shape.fifths;
const FIFTHS = Array.from({ length: (FIFTHS_SCHEMA.maxValue ?? 7) - (FIFTHS_SCHEMA.minValue ?? -7) + 1 }, (_, index) => (FIFTHS_SCHEMA.minValue ?? -7) + index);
const MODES = keySigSchema.shape.mode.options;
const REPEAT_SCHEMA = barSchema.shape.repeatEnd.unwrap();
const REPEAT = { min: REPEAT_SCHEMA.minValue ?? 2, max: REPEAT_SCHEMA.maxValue ?? undefined };
const PASS_SCHEMA = barSchema.shape.voltas.unwrap().element;
const PASSES = Array.from({ length: (PASS_SCHEMA.maxValue ?? 8) - (PASS_SCHEMA.minValue ?? 1) + 1 }, (_, index) => (PASS_SCHEMA.minValue ?? 1) + index);
const SECTION_LENGTH = 64;

const numerator = ref(props.timeSig.numerator);
const denominator = ref<TimeSignature["denominator"]>(props.timeSig.denominator);
const tempo = ref<number | "">(props.tempo ?? "");
const fifths = ref((props.keySig ?? props.keySigInForce).fifths);
const mode = ref<KeySignature["mode"]>((props.keySig ?? props.keySigInForce).mode);
const section = ref(props.section ?? "");
const repeatTimes = ref<number | "">(props.repeatEnd ?? REPEAT.min);
const passes = ref<number[]>([...props.voltas]);
const first = ref<HTMLInputElement>();
/** The passes ticked that the repeat is not played that many times for: they never sound. Told, not refused. */
const unplayedPasses = computed(() => [...passes.value].sort((a, b) => a - b).filter((pass) => pass > props.voltaRepeatTimes));

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

watch(
  () => [props.keySig?.fifths, props.keySig?.mode, props.keySigInForce.fifths, props.keySigInForce.mode, props.bar] as const,
  () => {
    const shown = props.keySig ?? props.keySigInForce;
    fifths.value = shown.fifths;
    mode.value = shown.mode;
  },
);
watch(
  () => [props.section, props.bar] as const,
  ([written]) => {
    section.value = written ?? "";
  },
);
watch(
  () => [props.repeatEnd, props.bar] as const,
  ([written]) => {
    repeatTimes.value = written ?? REPEAT.min;
  },
);
watch(
  () => [props.voltas.join(), props.bar] as const,
  () => {
    passes.value = [...props.voltas];
  },
);

function applyKeySig(): void {
  emit("keySig", { fifths: fifths.value, mode: mode.value });
}

function applySection(): void {
  const name = section.value.trim();
  emit("section", name === "" ? null : name);
}

function applyRepeat(): void {
  if (repeatTimes.value !== "") emit("repeat", { times: repeatTimes.value });
}

function applyVoltas(): void {
  emit("voltas", [...passes.value].sort((a, b) => a - b));
}

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
    <form class="bar-panel__group" data-panel-key-sig @submit.prevent="applyKeySig">
      <h3 class="bar-panel__label">{{ text.keySig }}</h3>
      <div class="bar-panel__row">
        <label class="bar-panel__field">
          <span>{{ text.keyMode }}</span>
          <select v-model="mode" name="mode">
            <option v-for="item in MODES" :key="item" :value="item">{{ text.keyModes[item] }}</option>
          </select>
        </label>
        <label class="bar-panel__field">
          <span>{{ text.key }}</span>
          <select v-model.number="fifths" name="fifths">
            <option v-for="item in FIFTHS" :key="item" :value="item">{{ text.keyName({ fifths: item, mode }) }}</option>
          </select>
        </label>
      </div>
      <p class="bar-panel__note">{{ props.keySig === undefined ? text.keySigInherited(bar, text.keyName(keySigInForce)) : text.keySigHere(bar) }}</p>
      <div class="bar-panel__row">
        <AppButton type="submit" variant="primary" size="sm">{{ text.apply }}</AppButton>
        <AppButton type="button" variant="ghost" size="sm" data-clear-key-sig :disabled="props.keySig === undefined" @click="emit('keySig', null)">{{ text.clearKeySig }}</AppButton>
      </div>
    </form>
    <form class="bar-panel__group" data-panel-section @submit.prevent="applySection">
      <label class="bar-panel__field">
        <span>{{ text.section }}</span>
        <input v-model="section" type="text" name="section" :maxlength="SECTION_LENGTH" />
      </label>
      <p class="bar-panel__note">{{ text.sectionHere(bar) }}</p>
      <div class="bar-panel__row">
        <AppButton type="submit" variant="primary" size="sm">{{ text.apply }}</AppButton>
        <AppButton type="button" variant="ghost" size="sm" data-clear-section :disabled="props.section === undefined" @click="emit('section', null)">{{ text.clearSection }}</AppButton>
      </div>
    </form>
    <form class="bar-panel__group" data-panel-repeat @submit.prevent="applyRepeat">
      <h3 class="bar-panel__label">{{ text.repeat }}</h3>
      <label class="bar-panel__field">
        <span>{{ text.repeatTimes }}</span>
        <input v-model.number="repeatTimes" class="bar-panel__number" type="number" name="repeatTimes" :min="REPEAT.min" :max="REPEAT.max" step="1" required />
      </label>
      <p class="bar-panel__note">{{ range ? text.repeatOnRange(range.first, range.last) : text.repeatOnBar }}</p>
      <p v-if="repeatStart" class="bar-panel__note" data-repeat-start>{{ text.repeatStartHere }}</p>
      <p v-if="repeatEnd !== undefined" class="bar-panel__note" data-repeat-end>{{ text.repeatEndHere(repeatEnd) }}</p>
      <div class="bar-panel__row">
        <AppButton type="submit" variant="primary" size="sm">{{ text.setRepeat }}</AppButton>
        <AppButton type="button" variant="ghost" size="sm" data-clear-repeat-start :disabled="!repeatStart" @click="emit('repeat', { clear: 'start' })">{{ text.clearRepeatStart }}</AppButton>
        <AppButton type="button" variant="ghost" size="sm" data-clear-repeat-end :disabled="repeatEnd === undefined" @click="emit('repeat', { clear: 'end' })">{{ text.clearRepeatEnd }}</AppButton>
      </div>
    </form>
    <form class="bar-panel__group" data-panel-voltas @submit.prevent="applyVoltas">
      <fieldset class="bar-panel__passes">
        <legend class="bar-panel__label">{{ text.voltas }}</legend>
        <label v-for="pass in PASSES" :key="pass" class="bar-panel__pass" :title="text.voltaPass(pass)">
          <input v-model="passes" type="checkbox" name="volta" :value="pass" :aria-label="text.voltaPass(pass)" />
          {{ pass }}
        </label>
      </fieldset>
      <p class="bar-panel__note">{{ range ? text.voltasOnRange : text.voltasOnBar }}</p>
      <p v-if="unplayedPasses.length > 0" class="bar-panel__warning" role="status" data-voltas-unplayed>{{ text.voltasUnplayed(unplayedPasses, voltaRepeatTimes) }}</p>
      <div class="bar-panel__row">
        <AppButton type="submit" variant="primary" size="sm">{{ text.apply }}</AppButton>
        <AppButton type="button" variant="ghost" size="sm" data-clear-voltas :disabled="voltas.length === 0" @click="emit('voltas', [])">{{ text.clearVoltas }}</AppButton>
      </div>
    </form>
    <div v-if="firstBar" class="bar-panel__group" data-panel-anacrusis>
      <label class="bar-panel__check">
        <input type="checkbox" name="anacrusis" :checked="anacrusis" @change="emit('anacrusis')" />
        {{ text.anacrusis }}
      </label>
      <p class="bar-panel__note">{{ text.anacrusisHelp }}</p>
    </div>
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
.bar-panel__warning {
  margin: 0;
  color: var(--danger);
  font-size: 0.75rem;
}
.bar-panel__passes {
  display: grid;
  grid-template-columns: repeat(4, auto);
  gap: 0.25rem 0.5rem;
  margin: 0;
  padding: 0;
  border: 0;
  font-size: 0.875rem;
}
.bar-panel__passes > legend {
  margin-bottom: 0.25rem;
}
.bar-panel__pass,
.bar-panel__check {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.875rem;
  white-space: nowrap;
}
.bar-panel__note {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.75rem;
  font-weight: normal;
}
</style>
