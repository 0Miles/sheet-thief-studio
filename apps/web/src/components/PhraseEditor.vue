<script setup lang="ts">
// The phrase editor itself (docs/spec/phrases.md, section 5), shared by the phrase's page
// (PhraseView) and the review page of a recognition (RecognitionView, section 7): a fragment
// typed and played as a score is. It becomes a score of one part, every id made anew, in a
// document of this component alone, not co-edited: the EditorSession types in it with the keys of
// the editable view, the same projection draws and plays it, at 120 (a phrase has no tempo). Undo
// is the page's, gone after a reload. Every change is told as the whole fragment (`change`); what
// becomes of it, saving it or not, is the page's.
// Not `editable` (a device that cannot be typed on, `canType`), the fragment is only drawn and
// played: no key nor click changes it.
// The page puts its own things in the slots: `lead` and `trail` in the toolbar, `banners` under
// it, `aside` beside the phrase, and the default slot after everything (its dialogs).
import { AppButton } from "@karyl-chan/ui";
import { createEditorSession, type EditorSession, keyNameOf, type LocalPresence, pageEffectOf, type TextRequest } from "@studio/score-editor";
import {
  type BarsFragment,
  cursorAt,
  docToJson,
  fragmentToScore,
  jsonToDoc,
  MAX_BEAT_TEXT,
  MAX_LYRIC,
  observeScore,
  type PitchedClef,
  readScore,
  type ScoreChange,
  type ScoreJSON,
  scoreToFragment,
  type TimeSignature,
} from "@studio/score-model";
import { createAlphaTabEngine, type Rect, type ScoreEngine } from "@studio/score-render";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import * as Y from "yjs";

import { barPanelOf } from "../barPanel";
import { listenToClipboard } from "../clipboard";
import { keyPlatform } from "../device";
import { useLyricEntry } from "../lyricEntry";
import { clearOf, entryRect, STRUCTURE_STROKE, structuralEnds, structureBoxesOf } from "../overlay";
import { selectionBoxes } from "../presence";
import { useScorePlayback } from "../scorePlayback";
import { type SoundUpdates, soundUpdates } from "../sound";
import { strings } from "../strings";
import { exposeForTests } from "../testHook";
import BarPanel from "./BarPanel.vue";
import InlineTextEntry from "./InlineTextEntry.vue";
import LyricEntry from "./LyricEntry.vue";
import PartPanel from "./PartPanel.vue";
import PlayerControls from "./PlayerControls.vue";

const props = defineProps<{
  /** What the editor opens; null until the page has it. */
  fragment: BarsFragment | null;
  /** Typed on; else only drawn and played. */
  editable: boolean;
  /** What a device that cannot be typed on is told. */
  desktopOnly: string;
}>();
const emit = defineEmits<{ change: [fragment: BarsFragment] }>();
const text = strings.phraseEditor;

/** The fragment is in the editor: the toolbar shows what plays and changes it. */
const started = ref(false);
/** The phrase is drawn: e2e tests wait for `data-ready` (docs/spec/testing.md, section 2). */
const ready = ref(false);
/** A notice for the member above the phrase (a key that did nothing); null when there is none. */
const notice = ref<string | null>(null);
/**
 * Tell the member something anew, as the score does (#57): the notice is emptied first, so that the
 * same words said again are a change the screen reader reads out again.
 */
function say(said: string): void {
  notice.value = null;
  void nextTick(() => {
    notice.value = said;
  });
}
const host = ref<HTMLElement>();
const scroller = ref<HTMLElement>();
const score = shallowRef<ScoreJSON | null>(null);
const presence = shallowRef<LocalPresence>({ cursor: null, selection: null });
const cursorRect = shallowRef<Rect | null>(null);
const selectionRects = shallowRef<Rect[]>([]);
const structureRects = shallowRef<Rect[]>([]);
const reserved = shallowRef<Rect[]>([]);
const textEntry = shallowRef<{ request: TextRequest; rect: Rect } | null>(null);
/** Lyrics mode, while Shift+Enter has it open on a staff (docs/spec/keymap.md, 6.2). */
const lyrics = useLyricEntry({
  session: () => session,
  boundsOf: (cursor) => engine?.renderer.boundsOf(cursor) ?? null,
  reserved: () => reserved.value,
  tell: say,
  done: focus,
});
const { request: lyricRequest, rect: lyricRect } = lyrics;
const panelOpen = ref(false);
const partsOpen = ref(false);
const barKeys = { insert: keyNameOf("insertBarBefore", keyPlatform()), remove: keyNameOf("deleteBars", keyPlatform()), panel: keyNameOf("barPanel", keyPlatform()) };

const doc = new Y.Doc();
let engine: ScoreEngine | undefined;
let session: EditorSession | undefined;
let sound: SoundUpdates | undefined;
let stopObserving: (() => void) | undefined;
const hideFromTests = exposeForTests({
  scoreJson: () => (stopObserving !== undefined ? docToJson(doc) : null),
  cursor: () => session?.cursor ?? null,
  flags: () => [],
  player: () => engine?.player.settings() ?? null,
});

// Typing plays from the start of the cursor's bar; a device that only plays, from where playback is.
const { playerState, stopped, playingBar, playheadRect, isFollowing, showPlayback, togglePlay, stop, retrySound, cursorMoved, stopFollowing, onScroll, reveal, attach } =
  useScorePlayback({
    scroller,
    reserved: () => reserved.value,
    startTick: (player) => {
      if (session === undefined) return null;
      const at = session.cursor;
      return (at && player.tickOf(at.barId)) ?? 0;
    },
    reading: () => false,
  });

const kind = computed(() => score.value?.parts[0]?.kind ?? null);
const panel = computed(() => (panelOpen.value && score.value !== null ? barPanelOf(score.value, presence.value) : null));

function focus(): void {
  scroller.value?.focus({ preventScroll: true });
}

// Drawing ----------------------------------------------------------------------------------------

function draw(change: ScoreChange): void {
  if (engine === undefined) return;
  const { score: json } = readScore(doc);
  score.value = json;
  if (change.kind === "structure") {
    engine.renderer.setScore(json, json.parts.map((part) => part.id));
    sound?.remade();
    return;
  }
  engine.renderer.patchBars(json, [...change.barIds]);
  sound?.changed();
}

/** A change here: drawn, and told as the whole fragment. */
function onChange(change: ScoreChange): void {
  draw(change);
  const json = score.value;
  // The session never deletes the last bar nor the part: the fragment is always there.
  if (json !== null && json.parts.length === 1 && json.bars.length > 0) emit("change", scoreToFragment(json));
}

function placeCursor(): void {
  if (engine === undefined || session === undefined) return;
  const at = session.cursor;
  const rect = at && engine.renderer.boundsOf(at);
  cursorRect.value = rect && clearOf(rect, reserved.value);
  const selection = session.selection;
  selectionRects.value = selection === null ? [] : selectionBoxes(engine.renderer, selection, reserved.value);
  structureRects.value = structureBoxesOf(engine.renderer, structuralEnds(selection, at, panelOpen.value), reserved.value);
  lyrics.place();
  updateLoop();
}

/** The selection is the loop (docs/spec/playback.md, section 4). */
function updateLoop(): void {
  if (engine === undefined || session === undefined) return;
  const selection = session.selection;
  engine.player.setLoop(selection && engine.player.loopOf(selection));
}

function updateOverlay(): void {
  if (engine === undefined) return;
  reserved.value = engine.renderer.reservedRects();
  placeCursor();
  showPlayback(engine.player.position.tick);
}

/** A button of the toolbar did its work: the phrase has the keyboard again. */
function onToolbar(action: () => void): void {
  action();
  focus();
}

// Typing -----------------------------------------------------------------------------------------

function onKey(event: KeyboardEvent): void {
  const pageEffect = pageEffectOf(event, keyPlatform());
  if (pageEffect === "playPause") {
    event.preventDefault();
    if (!event.repeat) togglePlay();
    return;
  }
  if (pageEffect === "barPanel") {
    event.preventDefault();
    togglePanel();
    return;
  }
  stopFollowing();
  // Without a session (a device that cannot be typed on), no key changes anything.
  if (session?.press(event)) event.preventDefault();
}

/** A click only moves the cursor; without a session it does nothing. */
function onPointer(event: PointerEvent): void {
  if (event.button !== 0 || event.target === scroller.value) return;
  if (event.target instanceof Element && event.target.closest("button") !== null) return;
  if (session === undefined || engine === undefined || host.value === undefined) return;
  const box = host.value.getBoundingClientRect();
  const hit = engine.renderer.hitTest(event.clientX - box.left, event.clientY - box.top);
  if (hit) session.moveTo(hit);
}

function openText(request: TextRequest): void {
  const at = cursorRect.value;
  if (at !== null) textEntry.value = { request, rect: entryRect(at, reserved.value) };
}

function closeText(typed: string | null): void {
  const entry = textEntry.value;
  textEntry.value = null;
  if (entry !== null && typed !== null) session?.setText(entry.request.cursor, typed);
  focus();
}

function togglePanel(): void {
  if (session === undefined) return;
  if (panelOpen.value) {
    closePanel();
    return;
  }
  partsOpen.value = false;
  panelOpen.value = true;
  placeCursor();
}

function closePanel(): void {
  panelOpen.value = false;
  placeCursor();
  focus();
}

function toggleParts(): void {
  if (partsOpen.value) {
    closeParts();
    return;
  }
  openParts();
}

/** The panel of the part's tuning (fretted) or clefs (pitched); only where the phrase can be changed. */
function openParts(): void {
  if (session === undefined || kind.value === null || kind.value === "percussion") return;
  panelOpen.value = false;
  placeCursor();
  partsOpen.value = true;
}

function closeParts(): void {
  partsOpen.value = false;
  focus();
}

function onTimeSig(timeSig: TimeSignature): void {
  session?.setTimeSig(timeSig);
}

function onTuning(partId: string, tuning: number[]): void {
  session?.setTuning(partId, tuning);
}

function onClef(partId: string, staff: number, clef: PitchedClef): void {
  session?.setClef(partId, staff, clef);
}

function startEditing(json: ScoreJSON): void {
  const part = json.parts[0];
  const first = json.bars[0];
  session = createEditorSession(doc, { platform: keyPlatform(), cursor: part && first ? cursorAt(doc, part.id, first.id) : null });
  presence.value = session.presence();
  session.onPresence((now) => {
    presence.value = now;
    placeCursor();
    cursorMoved();
    if (!isFollowing()) reveal(cursorRect.value);
  });
  session.onHint((hint) => say(strings.score.hints[hint]));
  session.onEditText(openText);
  session.onEditLyric(lyrics.open);
  placeCursor();
  scroller.value?.focus();
}

/** Open the fragment: drawn, played, and typed in when the device can be. Once. */
function start(fragment: BarsFragment): void {
  if (started.value || host.value === undefined) return;
  started.value = true;
  jsonToDoc(fragmentToScore(fragment), doc);
  // The editor lays out on the page's own thread, bar by bar, as the edit views do (docs/adr/0003);
  // a device that only plays lays out in a worker, and a click sends playback there.
  engine = createAlphaTabEngine(host.value, {
    fontDirectory: "/font/",
    soundFont: "/soundfont/sonivox.sf3",
    useWorkers: !props.editable,
    seekOnClick: !props.editable,
    scale: 1,
  });
  sound = soundUpdates(engine.player, "a", updateLoop);
  engine.renderer.onRendered(() => {
    ready.value = true;
    updateOverlay();
  });
  attach(engine);
  draw({ kind: "structure" });
  stopObserving = observeScore(doc, onChange);
  if (props.editable && score.value !== null) startEditing(score.value);
  else focus();
}

onMounted(() => {
  if (props.fragment !== null) start(props.fragment);
});
watch(
  () => props.fragment,
  (fragment) => {
    if (fragment !== null) start(fragment);
  },
);

// Copy, cut and paste while the phrase has the keyboard, as on a score: bars copied from a score go in here (docs/spec/phrases.md, section 2).
const stopClipboard = listenToClipboard({ scroller: () => scroller.value, session: () => session, tell: say });

onBeforeUnmount(() => {
  stopClipboard();
  hideFromTests();
  sound?.destroy();
  stopObserving?.();
  session?.destroy();
  engine?.destroy();
  doc.destroy();
});

defineExpose({ focus, openParts });
</script>

<template>
  <main class="phrase" :data-view="editable ? 'editable' : 'read'" :data-can-type="editable">
    <header class="phrase__toolbar">
      <slot name="lead" />
      <PlayerControls v-if="started" :state="playerState" :stopped="stopped" :bar="playingBar" @toggle="onToolbar(togglePlay)" @stop="onToolbar(stop)" @retry="onToolbar(retrySound)" />
      <div v-if="editable && started" class="phrase__bars">
        <AppButton variant="ghost" size="sm" data-insert-bar :title="strings.score.bars.insertKey(barKeys.insert)" @click="onToolbar(() => session?.insertBar('before'))">
          {{ strings.score.bars.insert }}
        </AppButton>
        <AppButton variant="ghost" size="sm" data-delete-bars :title="strings.score.bars.removeKey(barKeys.remove)" @click="onToolbar(() => session?.deleteBars())">
          {{ strings.score.bars.remove }}
        </AppButton>
        <AppButton variant="ghost" size="sm" data-toggle-panel :aria-pressed="panelOpen" :title="strings.score.bars.panelKey(barKeys.panel)" @click="togglePanel">
          {{ strings.score.bars.panel }}
        </AppButton>
        <AppButton v-if="kind !== null && kind !== 'percussion'" variant="ghost" size="sm" data-toggle-parts :aria-pressed="partsOpen" @click="toggleParts">
          {{ text.parts }}
        </AppButton>
      </div>
      <slot name="trail" />
      <p v-if="!editable && started" class="phrase__muted" data-desktop-only>{{ desktopOnly }}</p>
      <!-- Always there, as the score's status region is (#57): a live region that appears with its words is not read out everywhere. -->
      <div class="phrase__status" role="status">
        <p v-if="notice" class="phrase__notice">
          <span>{{ notice }}</span>
          <button type="button" class="phrase__dismiss" @click="onToolbar(() => (notice = null))">{{ strings.score.dismiss }}</button>
        </p>
      </div>
    </header>
    <slot name="banners" />
    <div class="phrase__body">
      <div ref="scroller" class="phrase__scroller" data-scroller tabindex="0" :aria-label="text.label" @keydown="onKey" @pointerdown="onPointer" @scroll.passive="onScroll">
        <div class="phrase__page">
          <div ref="host" :data-ready="ready"></div>
          <div v-if="editable && ready" class="phrase__end">
            <AppButton variant="ghost" size="sm" data-append-bar :title="strings.score.bars.appendTitle" @click="onToolbar(() => session?.appendBar())">{{ strings.score.bars.append }}</AppButton>
          </div>
          <svg class="phrase__overlay" aria-hidden="true">
            <rect v-for="(area, index) in reserved" :key="index" data-reserved :x="area.x" :y="area.y" :width="area.width" :height="area.height" fill="none" />
            <rect v-if="playheadRect" data-playhead class="phrase__playhead" :x="playheadRect.x" :y="playheadRect.y" :width="playheadRect.width" :height="playheadRect.height" />
            <rect v-for="(box, index) in selectionRects" :key="`selection-${index}`" data-selection class="phrase__selection" :x="box.x" :y="box.y" :width="box.width" :height="box.height" />
            <rect
              v-for="(box, index) in structureRects"
              :key="`structure-${index}`"
              data-structure
              class="phrase__structure"
              :stroke-width="STRUCTURE_STROKE"
              :x="box.x"
              :y="box.y"
              :width="box.width"
              :height="box.height"
            />
            <rect v-if="cursorRect" data-cursor class="phrase__cursor" :x="cursorRect.x" :y="cursorRect.y" :width="cursorRect.width" :height="cursorRect.height" rx="2" />
          </svg>
          <InlineTextEntry v-if="textEntry" :rect="textEntry.rect" :initial="textEntry.request.text" :max-length="MAX_BEAT_TEXT" :label="strings.score.beatText" @close="closeText" />
          <LyricEntry
            v-if="lyricRequest && lyricRect"
            :rect="lyricRect"
            :initial="lyricRequest.lyric"
            :beat-key="`${lyricRequest.cursor.barId}/${lyricRequest.cursor.beatId}`"
            :max-length="MAX_LYRIC"
            :label="strings.score.lyrics"
            @key="lyrics.onKey"
            @close="lyrics.close"
          />
        </div>
      </div>
      <BarPanel v-if="panel" :platform="keyPlatform()" v-bind="panel" phrase @time-sig="onTimeSig" @close="closePanel" />
      <PartPanel
        v-if="partsOpen && score"
        :platform="keyPlatform()"
        :parts="score.parts"
        :can-add="{ fretted: false, percussion: false, pitched: false }"
        :current="score.parts[0]?.id ?? null"
        phrase
        @tuning="onTuning"
        @clef="onClef"
        @close="closeParts"
      />
      <slot name="aside" />
    </div>
    <slot />
  </main>
</template>

<style scoped>
.phrase {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 3rem);
  height: calc(100dvh - 3rem);
}
.phrase__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
  padding: 0.5rem 1.5rem;
  border-bottom: 1px solid var(--border);
}
.phrase__muted {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.875rem;
}
.phrase__bars {
  display: flex;
  gap: 0.25rem;
}
.phrase__status {
  margin: 0 0 0 auto;
}
.phrase__notice {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin: 0;
  font-size: 0.875rem;
}
.phrase__body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.phrase__scroller {
  flex: 1;
  min-width: 0;
  overflow: auto;
  overflow-anchor: none;
  outline: none;
  /* The phrase is drawn in black: keep its page white in either theme. */
  background: #fff;
}
.phrase__page {
  position: relative;
}
.phrase__end {
  display: flex;
  justify-content: center;
  padding: 0.5rem 0 1.5rem;
}
.phrase__overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
.phrase__playhead {
  fill: rgba(37, 99, 235, 0.12);
}
.phrase__selection {
  fill: rgba(37, 99, 235, 0.18);
}
.phrase__structure {
  fill: none;
  stroke: rgba(37, 99, 235, 0.8);
  stroke-dasharray: 6 4;
}
.phrase__cursor {
  fill: rgba(234, 88, 12, 0.4);
}
/* A phone: what the page puts beside the phrase goes under it instead. */
@media (max-width: 767px) {
  .phrase__body {
    flex-direction: column;
  }
}
</style>
