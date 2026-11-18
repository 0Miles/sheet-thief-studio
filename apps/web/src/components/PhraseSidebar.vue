<script setup lang="ts">
// The phrase sidebar, at the side of the score in the editable view only (docs/spec/phrases.md,
// section 6): my phrases, those that fit the cursor's part unless all are asked for, searched by
// name. A click previews one in a popover in the sidebar's own column, never over the score (so it
// never covers the score's reserved areas); every preview shares one renderer, in a worker and
// without a player, drawn as a page that wraps to its width and scrolls down, never cut to a fixed
// height (alphaTab's mark shows for a score of more than 10 bars). A phrase is dragged onto a bar
// of the score, the page dropping it there, or Enter drops it on the cursor's bar: on the phrase
// focused, or in its preview, which takes the keyboard when it opens; never on the sidebar's own
// buttons, link and fields, whose Enter is theirs. No recognition here.
// Esc closes the preview, the keyboard back where it was, else the sidebar; F4 closes the sidebar.
// Keys are matched by the keymap's platform layer, as every key is.
import { AppButton } from "@karyl-chan/ui";
import { phraseList, type PhraseSummary } from "@studio/contracts";
import { type KeyPlatform, pageEffectOf, textEntryEffectOf } from "@studio/score-editor";
import { fragmentToScore, type PartJSON } from "@studio/score-model";
import { createAlphaTabEngine, type Rect, type ScoreEngine } from "@studio/score-render";
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { RouterLink } from "vue-router";

import { get, refusal } from "../api";
import { STRUCTURE_STROKE, structureBoxesOf } from "../overlay";
import { type PhraseContents, phrasesShown } from "../phraseSidebar";
import { strings } from "../strings";

const props = defineProps<{
  platform: KeyPlatform;
  /** Shown: the sidebar stays in the page while hidden, so that its one renderer lasts. */
  open: boolean;
  /** The cursor's part, which the phrases listed fit; undefined without a cursor. */
  part: PartJSON | undefined;
  contents: PhraseContents;
}>();
const emit = defineEmits<{
  close: [];
  /** Enter: the phrase goes on the cursor's bar. */
  drop: [phrase: PhraseSummary];
  /** A phrase is dragged from the list; `null` once the drag is over, dropped or not. */
  drag: [phrase: PhraseSummary | null];
}>();
const text = strings.score.phraseSidebar;

const search = ref("");
const showAll = ref(false);
const phrases = shallowRef<PhraseSummary[] | null>(null);
const loadError = ref<string | null>(null);
const searchBox = ref<HTMLInputElement>();
/** The phrase previewed, while the popover is open. */
const previewed = shallowRef<PhraseSummary | null>(null);
const previewError = ref<string | null>(null);
/** The preview is drawn: e2e tests wait for `data-preview-ready`. */
const previewReady = ref(false);
const previewHost = ref<HTMLElement>();
const previewSection = ref<HTMLElement>();
/** What had the keyboard when the preview opened (the phrase clicked): it has it again once the preview closes. */
let opener: HTMLElement | null = null;
const previewReserved = shallowRef<Rect[]>([]);
/** The bars of the phrase, outlined: what goes in on a drop. Out of the reserved areas. */
const previewBars = shallowRef<Rect[]>([]);
/** The bars of the phrase drawn last, first and last: the outline goes over them. */
let previewEnds: [string, string] | null = null;
/** The one renderer every preview shares, made the first time one opens. */
let engine: ScoreEngine | undefined;

const listed = computed(() => (phrases.value === null ? [] : phrasesShown(phrases.value, props.part, showAll.value)));
/** What the list says when it has nothing to list. */
const emptyText = computed(() => {
  if (phrases.value === null || listed.value.length > 0) return null;
  if (search.value.trim() !== "") return text.noMatch;
  return phrases.value.length === 0 ? text.empty : text.noneFit;
});

/** Each request answers only if no later one was made: typing fast keeps the newest. */
let asked = 0;
async function load(): Promise<void> {
  const mine = ++asked;
  const q = search.value.trim();
  try {
    const list = (await get(`/api/phrases${q === "" ? "" : `?${new URLSearchParams({ q })}`}`, phraseList)).phrases;
    if (mine !== asked) return;
    phrases.value = list;
    loadError.value = null;
  } catch (failure) {
    if (mine === asked) loadError.value = refusal(failure);
  }
}

let typing: ReturnType<typeof setTimeout> | undefined;
watch(search, () => {
  clearTimeout(typing);
  typing = setTimeout(() => void load(), 200);
});

// Opened: the list as it is now, the keyboard in the search box (docs/spec/keymap.md, section 5).
watch(
  () => props.open,
  (open) => {
    if (!open) {
      previewed.value = null;
      return;
    }
    void load();
    void nextTick(() => searchBox.value?.focus());
  },
  { immediate: true },
);

/** Draw the outline and the reserved areas again, as of the preview's last drawing. */
function placePreview(): void {
  if (engine === undefined) return;
  previewReserved.value = engine.renderer.reservedRects();
  previewBars.value = structureBoxesOf(engine.renderer, previewEnds, previewReserved.value);
}

/**
 * A click on a phrase: its preview opens, the keyboard going into it (Enter there drops the
 * phrase), or closes when it is open already, the keyboard back on the phrase.
 */
async function preview(phrase: PhraseSummary, from: EventTarget | null): Promise<void> {
  if (previewed.value?.id === phrase.id) {
    closePreview();
    return;
  }
  opener = from instanceof HTMLElement ? from : null;
  previewed.value = phrase;
  void nextTick(() => previewSection.value?.focus({ preventScroll: true }));
  previewReady.value = false;
  previewError.value = null;
  previewReserved.value = [];
  previewBars.value = [];
  let fragment;
  try {
    fragment = await props.contents.of(phrase);
  } catch (failure) {
    if (previewed.value === phrase) previewError.value = refusal(failure);
    return;
  }
  // Laid out at the width the popover has once it is shown.
  await nextTick();
  if (previewed.value !== phrase || previewHost.value === undefined) return;
  if (engine === undefined) {
    engine = createAlphaTabEngine(previewHost.value, { fontDirectory: "/font/", soundFont: null, useWorkers: true, scale: 0.75 });
    engine.renderer.onRendered(() => {
      previewReady.value = true;
      placePreview();
    });
  }
  const score = fragmentToScore(fragment);
  previewEnds = score.bars.length === 0 ? null : [score.bars[0]!.id, score.bars.at(-1)!.id];
  engine.renderer.setScore(score);
}

/** The preview closes, the keyboard going back where it was when it opened (the search box when that is gone). */
function closePreview(): void {
  previewed.value = null;
  const back = opener?.isConnected ? opener : searchBox.value;
  opener = null;
  back?.focus();
}

// Closed (or the sidebar with it): nothing of the preview is left in the page's overlays.
watch(previewed, (now) => {
  if (now !== null) return;
  previewReserved.value = [];
  previewBars.value = [];
  previewEnds = null;
});

/** What in the sidebar does its own thing with Enter: its buttons, its link, its fields (and anything marked so). */
const OWN_ENTER = "button, a, input, select, textarea, [data-no-drop]";

/**
 * The phrase Enter drops: the one focused in the list; else, with the focus in the preview, the
 * one previewed. None on the sidebar's other buttons, its link or its fields, whose Enter is
 * their own (closing the preview, searching…).
 */
function phraseOf(target: EventTarget | null): PhraseSummary | null {
  if (!(target instanceof Element)) return null;
  const item = target.closest<HTMLElement>("[data-phrase-id]");
  if (item !== null) return listed.value.find((phrase) => phrase.id === item.dataset.phraseId) ?? null;
  if (target.closest(OWN_ENTER) !== null) return null;
  return target.closest("[data-phrase-preview]") === null ? null : previewed.value;
}

function onKey(event: KeyboardEvent): void {
  if (pageEffectOf(event, props.platform) === "phraseSidebar") {
    event.preventDefault();
    emit("close");
    return;
  }
  const effect = textEntryEffectOf(event, props.platform);
  if (effect === "cancelEntry") {
    event.preventDefault();
    if (previewed.value !== null) closePreview();
    else emit("close");
    return;
  }
  if (effect !== "saveEntry") return;
  const phrase = phraseOf(event.target);
  if (phrase === null) return;
  // Not the button's own click, which previews.
  event.preventDefault();
  emit("drop", phrase);
}

function onDragStart(event: DragEvent, phrase: PhraseSummary): void {
  if (event.dataTransfer === null) return;
  // Firefox starts no drag without data; the page itself knows which phrase it is.
  event.dataTransfer.setData("application/x-studio-phrase", phrase.id);
  event.dataTransfer.effectAllowed = "copy";
  emit("drag", phrase);
}

onBeforeUnmount(() => {
  clearTimeout(typing);
  engine?.destroy();
});
</script>

<template>
  <aside class="phrase-sidebar" data-phrase-sidebar :aria-label="text.title" @keydown="onKey">
    <header class="phrase-sidebar__header">
      <h2 class="phrase-sidebar__title">{{ text.title }}</h2>
      <RouterLink class="phrase-sidebar__library" :to="{ name: 'phrases' }">{{ text.library }}</RouterLink>
      <AppButton variant="ghost" size="sm" data-close-sidebar @click="emit('close')">{{ text.close }}</AppButton>
    </header>
    <input ref="searchBox" v-model="search" class="phrase-sidebar__search" type="search" data-phrase-search :aria-label="text.search" :placeholder="text.search" maxlength="100" />
    <label class="phrase-sidebar__all">
      <input v-model="showAll" type="checkbox" data-show-all />
      {{ text.showAll }}
    </label>
    <p class="phrase-sidebar__help">{{ text.help }}</p>
    <p v-if="loadError" class="phrase-sidebar__error" role="alert">{{ loadError }}</p>
    <p v-else-if="phrases === null" class="phrase-sidebar__help">{{ strings.loading }}</p>
    <p v-else-if="emptyText" class="phrase-sidebar__help" data-phrases-empty>{{ emptyText }}</p>
    <ul class="phrase-sidebar__list">
      <li v-for="phrase in listed" :key="phrase.id">
        <button
          type="button"
          class="phrase-sidebar__phrase"
          data-phrase
          :data-phrase-id="phrase.id"
          :aria-pressed="previewed?.id === phrase.id"
          draggable="true"
          @click="preview(phrase, $event.currentTarget)"
          @dragstart="onDragStart($event, phrase)"
          @dragend="emit('drag', null)"
        >
          <span class="phrase-sidebar__name">{{ phrase.name }}</span>
          <span class="phrase-sidebar__details">{{ strings.phrases.details(phrase) }}</span>
        </button>
      </li>
    </ul>
    <!-- In the sidebar's column, never over the score. Kept in the page: its renderer lasts. -->
    <section
      v-show="previewed"
      ref="previewSection"
      class="phrase-sidebar__preview"
      role="dialog"
      tabindex="-1"
      data-phrase-preview :data-preview-ready="previewReady" :aria-label="previewed ? text.preview(previewed.name) : undefined">
      <header class="phrase-sidebar__preview-header">
        <h3 class="phrase-sidebar__preview-title">{{ previewed?.name }}</h3>
        <AppButton variant="ghost" size="sm" data-close-preview @click="closePreview">{{ text.closePreview }}</AppButton>
      </header>
      <p v-if="previewError" class="phrase-sidebar__error" role="alert">{{ previewError }}</p>
      <!-- Scrolls down: never cut to a fixed height. -->
      <div class="phrase-sidebar__preview-scroller" data-preview-scroller>
        <div class="phrase-sidebar__preview-page">
          <div ref="previewHost" data-preview-host></div>
          <svg class="phrase-sidebar__preview-overlay" aria-hidden="true" data-preview-overlay>
            <rect v-for="(area, index) in previewReserved" :key="index" data-reserved :x="area.x" :y="area.y" :width="area.width" :height="area.height" fill="none" />
            <rect
              v-for="(box, index) in previewBars"
              :key="`bars-${index}`"
              data-preview-bars
              class="phrase-sidebar__preview-bars"
              :stroke-width="STRUCTURE_STROKE"
              :x="box.x"
              :y="box.y"
              :width="box.width"
              :height="box.height"
            />
          </svg>
        </div>
      </div>
      <AppButton v-if="previewed" variant="primary" size="sm" data-drop-at-cursor @click="emit('drop', previewed)">{{ text.dropAtCursor }}</AppButton>
    </section>
  </aside>
</template>

<style scoped>
.phrase-sidebar {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  width: 22rem;
  flex: none;
  min-height: 0;
  padding: 0.75rem 1rem;
  border-left: 1px solid var(--border);
  background: var(--bg-surface);
  overflow-y: auto;
}
.phrase-sidebar__header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.phrase-sidebar__title {
  margin: 0 auto 0 0;
  font-size: 1rem;
}
.phrase-sidebar__library {
  font-size: 0.875rem;
}
.phrase-sidebar__search {
  width: 100%;
  box-sizing: border-box;
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: inherit;
  font: inherit;
}
.phrase-sidebar__all {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.875rem;
}
.phrase-sidebar__help {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.8125rem;
}
.phrase-sidebar__error {
  margin: 0;
  color: var(--danger);
  font-size: 0.875rem;
}
.phrase-sidebar__list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.phrase-sidebar__phrase {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  padding: 0.375rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: grab;
}
.phrase-sidebar__phrase[aria-pressed="true"] {
  border-color: var(--accent, #2563eb);
}
.phrase-sidebar__name {
  overflow-wrap: anywhere;
}
.phrase-sidebar__details {
  color: var(--text-muted);
  font-size: 0.75rem;
}
/* A popover in the sidebar's column. */
.phrase-sidebar__preview {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
  background: var(--bg-surface);
}
.phrase-sidebar__preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.phrase-sidebar__preview-title {
  margin: 0;
  font-size: 0.875rem;
  overflow-wrap: anywhere;
}
/* Scrolls down; the page inside it as tall as the phrase is drawn. */
.phrase-sidebar__preview-scroller {
  max-height: 50vh;
  overflow: auto;
  background: #fff;
}
.phrase-sidebar__preview-page {
  position: relative;
}
.phrase-sidebar__preview-overlay {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
/* Dashed, as the boxes of a structural command: its stroke inside the rectangle (`structureBoxesOf`). */
.phrase-sidebar__preview-bars {
  fill: none;
  stroke: rgba(37, 99, 235, 0.6);
  stroke-dasharray: 6 4;
}
</style>
