<script setup lang="ts">
// The panel of the parts, at the side of the score in the editable view (docs/spec/commands.md,
// 7.1 and 7.2): the parts in score order, dragged (or moved up and down) into another order, added
// from the presets, deleted (the page asks first), and the properties of one of them changed: its
// name, a fretted part's tuning and capo, the program of any but drums, the clefs of a pitched
// part. Its kind, its number of strings and of staves never change. Each change is one command of
// the session, the page's.
// Keys in its fields are theirs; Esc closes the panel, matched by the keymap's platform layer.
import { AppButton, AppTextField } from "@karyl-chan/ui";
import { type KeyPlatform, textEntryEffectOf } from "@studio/score-editor";
import {
  MAX_PART_NAME,
  type PartJSON,
  type PartKind,
  PART_PRESET_IDS,
  PART_PRESETS,
  type PartPresetId,
  partSchemas,
  PITCHED_CLEFS,
  type PitchedClef,
  pitchName,
  TUNING_OPTIONS,
  type TuningOption,
  tuningFor,
  tuningOptionOf,
} from "@studio/score-model";
import { computed, nextTick, onMounted, ref, watch } from "vue";

import { strings } from "../strings";

const props = defineProps<{
  platform: KeyPlatform;
  /** The parts, in score order. */
  parts: readonly PartJSON[];
  /** Whether a part of each kind may still be added (`canAddPart`). */
  canAdd: Record<PartKind, boolean>;
  /** The part whose properties show first: the cursor's. */
  current: string | null;
  /**
   * The phrase editor's: a phrase is one part, with no name, capo nor program of its own (docs/
   * spec/phrases.md, section 5), so the panel has only its tuning or its clefs.
   */
  phrase?: boolean;
}>();
const emit = defineEmits<{
  add: [preset: PartPresetId, tuning: number[] | undefined];
  remove: [partId: string];
  move: [partId: string, after: string | null];
  name: [partId: string, name: string];
  tuning: [partId: string, tuning: number[]];
  capo: [partId: string, capo: number];
  program: [partId: string, program: number];
  clef: [partId: string, staff: number, clef: PitchedClef];
  close: [];
}>();
const text = strings.score.parts;
const TUNINGS = [...TUNING_OPTIONS, "custom"] as const;
/** Every MIDI pitch a string can be tuned to, with its name. */
const PITCHES = Array.from({ length: 128 }, (_, pitch) => ({ pitch, name: pitchName(pitch) }));
const range = (schema: { minValue: number | null; maxValue: number | null }) => ({ min: schema.minValue ?? undefined, max: schema.maxValue ?? undefined });
const CAPO = range(partSchemas.fretted.shape.capo);
const PROGRAM = range(partSchemas.fretted.shape.program);

// Adding -----------------------------------------------------------------------------------------

const preset = ref<PartPresetId>(PART_PRESET_IDS[0]);
const addTuning = ref<TuningOption>("standard");
const presetKind = computed(() => PART_PRESETS[preset.value].kind);
const addFirst = ref<HTMLSelectElement>();

function add(): void {
  const strings = PART_PRESETS[preset.value].tuning.length;
  const tuning = presetKind.value === "fretted" && addTuning.value !== "standard" ? tuningFor(addTuning.value, strings) : undefined;
  emit("add", preset.value, tuning);
}

// The part edited --------------------------------------------------------------------------------

const editedId = ref<string | null>(props.current ?? props.parts[0]?.id ?? null);
const edited = computed(() => props.parts.find((part) => part.id === editedId.value) ?? null);
// The part edited is gone (deleted, here or elsewhere): the first one instead.
watch(
  () => props.parts.map((part) => part.id).join(),
  () => {
    if (edited.value === null) editedId.value = props.current ?? props.parts[0]?.id ?? null;
  },
);

const name = ref("");
const tuningOption = ref<TuningOption | "custom">("standard");
const custom = ref<number[]>([]);
const capo = ref<number | "">(0);
const program = ref<number | "">(0);
const clefs = ref<PitchedClef[]>([]);

/** The fields of the part edited, as it is now: after another part is chosen, or someone changed it. */
function fill(): void {
  const part = edited.value;
  if (part === null) return;
  name.value = part.name;
  tuningOption.value = tuningOptionOf(part.tuning);
  custom.value = [...part.tuning];
  capo.value = part.capo;
  program.value = part.program;
  clefs.value = part.staves.map((staff) => staff.clef as PitchedClef);
}
watch(() => edited.value && JSON.stringify({ ...edited.value, content: undefined }), fill, { immediate: true });

function applyName(): void {
  const part = edited.value;
  const given = name.value.trim();
  if (part !== null && given !== "") emit("name", part.id, given);
}

function applyTuning(): void {
  const part = edited.value;
  if (part === null) return;
  emit("tuning", part.id, tuningOption.value === "custom" ? [...custom.value] : tuningFor(tuningOption.value, part.tuning.length));
}

function applyCapo(): void {
  if (edited.value !== null && capo.value !== "") emit("capo", edited.value.id, capo.value);
}

function applyProgram(): void {
  if (edited.value !== null && program.value !== "") emit("program", edited.value.id, program.value);
}

function applyClef(staff: number): void {
  const clef = clefs.value[staff];
  if (edited.value !== null && clef !== undefined) emit("clef", edited.value.id, staff, clef);
}

// Order ------------------------------------------------------------------------------------------

/** Move a part to `index` of the order (the others' indexes as they are now). */
function moveTo(partId: string, index: number): void {
  const others = props.parts.map((part) => part.id).filter((id) => id !== partId);
  const clamped = Math.max(0, Math.min(index, others.length));
  emit("move", partId, clamped === 0 ? null : (others[clamped - 1] as string));
}

function step(partId: string, by: -1 | 1): void {
  moveTo(partId, props.parts.findIndex((part) => part.id === partId) + by);
}

/** The part being dragged, while it is. */
const dragged = ref<string | null>(null);

function onDragStart(event: DragEvent, partId: string): void {
  dragged.value = partId;
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    // Some browsers start a drag only with data in it.
    event.dataTransfer.setData("text/plain", partId);
  }
}

/** A part dropped on another takes its place: the one dropped on moves aside, down or up. */
function onDrop(target: string): void {
  const from = dragged.value;
  dragged.value = null;
  if (from === null || from === target) return;
  // Among the others, the target's index puts the part right after it when dragged down, right before it when dragged up.
  moveTo(from, props.parts.findIndex((part) => part.id === target));
}

function onKey(event: KeyboardEvent): void {
  if (textEntryEffectOf(event, props.platform) === "cancelEntry") {
    event.preventDefault();
    emit("close");
  }
}

onMounted(() => void nextTick(() => addFirst.value?.focus()));
</script>

<template>
  <aside class="part-panel" data-part-panel :aria-label="text.panel" @keydown="onKey">
    <header class="part-panel__header">
      <h2 class="part-panel__title">{{ text.panel }}</h2>
      <AppButton variant="ghost" size="sm" data-close-parts @click="emit('close')">{{ text.close }}</AppButton>
    </header>
    <section v-if="!phrase" class="part-panel__group">
      <h3 class="part-panel__label">{{ text.list }}</h3>
      <ol class="part-panel__list">
        <li
          v-for="(part, index) in parts"
          :key="part.id"
          class="part-panel__part"
          data-part-row
          :data-part-id="part.id"
          :data-dragging="dragged === part.id || undefined"
          draggable="true"
          :title="text.drag(part.name)"
          @dragstart="onDragStart($event, part.id)"
          @dragend="dragged = null"
          @dragover.prevent
          @drop.prevent="onDrop(part.id)"
        >
          <button type="button" class="part-panel__name" data-part-edit :aria-pressed="part.id === editedId" :title="text.edit(part.name)" @click="editedId = part.id">
            <span>{{ part.name || strings.score.untitled }}</span>
            <span class="part-panel__note">{{ text.kinds[part.kind] }}{{ part.kind === "fretted" ? ` · ${text.strings(part.tuning.length)}` : "" }}</span>
          </button>
          <div class="part-panel__actions">
            <AppButton variant="ghost" size="sm" data-part-up :disabled="index === 0" :aria-label="text.moveUp(part.name)" @click="step(part.id, -1)">{{ text.up }}</AppButton>
            <AppButton variant="ghost" size="sm" data-part-down :disabled="index === parts.length - 1" :aria-label="text.moveDown(part.name)" @click="step(part.id, 1)">{{ text.down }}</AppButton>
            <AppButton variant="ghost" size="sm" data-part-delete :disabled="parts.length === 1" :aria-label="text.removeOf(part.name)" @click="emit('remove', part.id)">{{ text.remove }}</AppButton>
          </div>
        </li>
      </ol>
    </section>
    <form v-if="!phrase" class="part-panel__group" data-add-part @submit.prevent="add">
      <h3 class="part-panel__label">{{ text.add }}</h3>
      <div class="part-panel__row">
        <label class="native-label">
          <span>{{ text.preset }}</span>
          <select ref="addFirst" v-model="preset" name="preset" @change="addTuning = 'standard'">
            <option v-for="item in PART_PRESET_IDS" :key="item" :value="item">{{ strings.presets[item] }}</option>
          </select>
        </label>
        <label v-if="presetKind === 'fretted'" class="native-label">
          <span>{{ text.tuning }}</span>
          <select v-model="addTuning" name="tuning">
            <option v-for="item in TUNING_OPTIONS" :key="item" :value="item">{{ strings.newScore.tunings[item] }}</option>
          </select>
        </label>
      </div>
      <p v-if="!canAdd[presetKind]" class="part-panel__warning" role="status" data-part-limit>{{ text.atLimit }}</p>
      <AppButton type="submit" variant="primary" size="sm" :disabled="!canAdd[presetKind]">{{ text.add }}</AppButton>
    </form>
    <section v-if="edited" class="part-panel__group" data-part-properties :data-part-id="edited.id">
      <h3 v-if="!phrase" class="part-panel__label">{{ text.properties(edited.name) }}</h3>
      <p class="part-panel__note">{{ text.fixed }}</p>
      <form v-if="!phrase" class="part-panel__group" data-part-name @submit.prevent="applyName">
        <AppTextField v-model="name" :label="text.name" name="name" :maxlength="MAX_PART_NAME" required />
        <AppButton type="submit" variant="primary" size="sm">{{ text.apply }}</AppButton>
      </form>
      <form v-if="edited.kind === 'fretted'" class="part-panel__group" data-part-tuning @submit.prevent="applyTuning">
        <label class="native-label">
          <span>{{ text.tuning }}</span>
          <select v-model="tuningOption" name="tuning">
            <option v-for="item in TUNINGS" :key="item" :value="item">{{ strings.newScore.tunings[item] }}</option>
          </select>
        </label>
        <div v-if="tuningOption === 'custom'" class="part-panel__row">
          <label v-for="(_, index) in custom" :key="index" class="native-label">
            <span>{{ strings.newScore.string(index + 1) }}</span>
            <select v-model.number="custom[index]" :name="`string-${index + 1}`">
              <option v-for="{ pitch, name: pitchLabel } in PITCHES" :key="pitch" :value="pitch">{{ pitchLabel }}</option>
            </select>
          </label>
        </div>
        <p class="part-panel__note">{{ text.tuningHelp }}</p>
        <AppButton type="submit" variant="primary" size="sm">{{ text.apply }}</AppButton>
      </form>
      <form v-if="edited.kind === 'fretted' && !phrase" class="part-panel__group" data-part-capo @submit.prevent="applyCapo">
        <AppTextField v-model.number="capo" :label="text.capo" type="number" name="capo" :min="CAPO.min" :max="CAPO.max" :step="1" required />
        <AppButton type="submit" variant="primary" size="sm">{{ text.apply }}</AppButton>
      </form>
      <form v-if="edited.kind !== 'percussion' && !phrase" class="part-panel__group" data-part-program @submit.prevent="applyProgram">
        <AppTextField v-model.number="program" :label="text.program" type="number" name="program" :min="PROGRAM.min" :max="PROGRAM.max" :step="1" required />
        <AppButton type="submit" variant="primary" size="sm">{{ text.apply }}</AppButton>
      </form>
      <form v-for="(_, staff) in edited.kind === 'pitched' ? clefs : []" :key="staff" class="part-panel__group" data-part-clef @submit.prevent="applyClef(staff)">
        <label class="native-label">
          <span>{{ text.clef(staff + 1) }}</span>
          <select v-model="clefs[staff]" :name="`clef-${staff + 1}`">
            <option v-for="item in PITCHED_CLEFS" :key="item" :value="item">{{ text.clefs[item] }}</option>
          </select>
        </label>
        <p class="part-panel__note">{{ text.clefHelp }}</p>
        <AppButton type="submit" variant="primary" size="sm">{{ text.apply }}</AppButton>
      </form>
    </section>
  </aside>
</template>

<style scoped>
.part-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  width: 18rem;
  flex: none;
  padding: var(--space-3) var(--space-4);
  border-left: 1px solid var(--border);
  background: var(--bg-surface);
  overflow-y: auto;
}
.part-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.part-panel__title {
  margin: 0;
  font-size: 1rem;
}
.part-panel__group {
  display: grid;
  gap: var(--space-2);
}
.part-panel__label {
  margin: 0;
  font-size: 0.875rem;
}
.part-panel__list {
  display: grid;
  gap: var(--space-1);
  margin: 0;
  padding: 0;
  list-style: none;
}
.part-panel__part {
  display: grid;
  gap: 0.125rem;
  padding: var(--space-1) 0.375rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-base);
  background: var(--bg-page);
  cursor: grab;
}
.part-panel__part[data-dragging] {
  opacity: 0.5;
}
.part-panel__name {
  display: flex;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  font-size: 0.875rem;
  text-align: left;
  cursor: pointer;
}
.part-panel__name[aria-pressed="true"] {
  font-weight: 600;
}
.part-panel__actions,
.part-panel__row {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: var(--space-1) var(--space-2);
}
.part-panel__warning {
  margin: 0;
  color: var(--danger);
  font-size: 0.75rem;
}
.part-panel__note {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.75rem;
  font-weight: normal;
}
</style>
