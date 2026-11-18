<script setup lang="ts">
// The phrase editor (`/phrases/:id`; docs/spec/phrases.md, section 5): a phrase typed and played
// as a score is. Its fragment becomes a score of one part, every id made anew, in a document of
// this page alone, not co-edited: the EditorSession types in it with the keys of the editable
// view, the same projection draws and plays it, at 120 (a phrase has no tempo). Undo is this
// page's, gone after a reload. Each change is saved as the whole fragment (phraseSaver.ts); a
// phrase changed elsewhere since is reloaded or saved as a new phrase, never merged.
// On a device that cannot be typed on (`canType`), the phrase is only drawn and played: no key nor
// click changes it, and nothing is ever saved.
import { AppButton, AppModal, AppTextField, Cluster, Stack } from "@karyl-chan/ui";
import { phraseDetails, type PhraseDetails, phraseLimits } from "@studio/contracts";
import { createEditorSession, type EditorSession, keyNameOf, type LocalPresence, pageEffectOf, type TextRequest } from "@studio/score-editor";
import {
  cursorAt,
  docToJson,
  fragmentToScore,
  jsonToDoc,
  MAX_BEAT_TEXT,
  observeScore,
  type PitchedClef,
  readScore,
  type ScoreChange,
  type ScoreJSON,
  scoreToFragment,
  type TimeSignature,
} from "@studio/score-model";
import { createAlphaTabEngine, type PlayerState, playerUsable, type Rect, type ScoreEngine } from "@studio/score-render";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { RouterLink, useRouter } from "vue-router";
import * as Y from "yjs";

import { ApiError, get, refusal } from "../api";
import { barPanelOf } from "../barPanel";
import AppHeader from "../components/AppHeader.vue";
import BarPanel from "../components/BarPanel.vue";
import InlineTextEntry from "../components/InlineTextEntry.vue";
import PartPanel from "../components/PartPanel.vue";
import PlayerControls from "../components/PlayerControls.vue";
import { canType, keyPlatform } from "../device";
import { clearOf, entryRect, sameRect, STRUCTURE_STROKE, structuralEnds, structureBoxesOf } from "../overlay";
import { createPhraseSaver, type PhraseSaver, type SaveState } from "../phraseSaver";
import { selectionBoxes } from "../presence";
import { type SoundUpdates, soundUpdates } from "../sound";
import { errorText, strings } from "../strings";
import { exposeForTests } from "../testHook";
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
/** The phrase is drawn: e2e tests wait for `data-ready` (docs/spec/testing.md, section 2). */
const ready = ref(false);
const saveState = ref<SaveState>("saved");
/** What a refusal of the last save said, while `failed` for one. */
const saveError = ref<string | null>(null);
/** A notice for the member above the phrase (a key that did nothing); null when there is none. */
const notice = ref<string | null>(null);
const host = ref<HTMLElement>();
const scroller = ref<HTMLElement>();
const score = shallowRef<ScoreJSON | null>(null);
const presence = shallowRef<LocalPresence>({ cursor: null, selection: null });
const cursorRect = shallowRef<Rect | null>(null);
const selectionRects = shallowRef<Rect[]>([]);
const structureRects = shallowRef<Rect[]>([]);
const reserved = shallowRef<Rect[]>([]);
const textEntry = shallowRef<{ request: TextRequest; rect: Rect } | null>(null);
const panelOpen = ref(false);
const partsOpen = ref(false);
const playerState = ref<PlayerState>("loading");
const stopped = ref(true);
const playingBar = ref<number | null>(null);
const playheadRect = shallowRef<Rect | null>(null);
/** Paused by the member, the cursor not moved since: playing goes on from there. */
let resumable = false;
/** Playback is kept on screen: from pressing play until the member presses a key or scrolls. */
let keepInSight = false;
/** Where the page itself last scrolled to: a scroll anywhere else is the member's. */
let ownScrollTop: number | null = null;
const barKeys = { insert: keyNameOf("insertBarBefore", keyPlatform()), remove: keyNameOf("deleteBars", keyPlatform()), panel: keyNameOf("barPanel", keyPlatform()) };

const doc = new Y.Doc();
let engine: ScoreEngine | undefined;
let session: EditorSession | undefined;
let saver: PhraseSaver | undefined;
let sound: SoundUpdates | undefined;
let stopObserving: (() => void) | undefined;
const hideFromTests = exposeForTests({
  scoreJson: () => (stopObserving !== undefined ? docToJson(doc) : null),
  cursor: () => session?.cursor ?? null,
  flags: () => [],
  player: () => engine?.player.settings() ?? null,
});

const kind = computed(() => score.value?.parts[0]?.kind ?? null);
const panel = computed(() => (panelOpen.value && score.value !== null ? barPanelOf(score.value, presence.value) : null));
/** What the save says when it did not go through; null while it goes or went through. */
const saveProblem = computed(() => {
  if (saveState.value === "tooLarge") return errorText("phrase_too_large");
  if (saveState.value === "failed") return saveError.value ?? text.retrying;
  return null;
});

function focusScore(): void {
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

/** A change here: drawn, and the whole fragment saved once editing stops. */
function onChange(change: ScoreChange): void {
  draw(change);
  const json = score.value;
  // The session never deletes the last bar nor the part: the fragment is always there.
  if (saver !== undefined && json !== null && json.parts.length === 1 && json.bars.length > 0) saver.edit(scoreToFragment(json));
}

function placeCursor(): void {
  if (engine === undefined || session === undefined) return;
  const at = session.cursor;
  const rect = at && engine.renderer.boundsOf(at);
  cursorRect.value = rect && clearOf(rect, reserved.value);
  const selection = session.selection;
  selectionRects.value = selection === null ? [] : selectionBoxes(engine.renderer, selection, reserved.value);
  structureRects.value = structureBoxesOf(engine.renderer, structuralEnds(selection, at, panelOpen.value), reserved.value);
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

// Playing ----------------------------------------------------------------------------------------

const FOLLOW_MARGIN = 40;

function showPlayback(tick: number): void {
  if (engine === undefined || stopped.value) return;
  const played = engine.player.barAt(tick);
  if (played !== null) playingBar.value = played.index + 1;
  const rect = engine.renderer.boundsAtTick(tick);
  const placed = rect && clearOf(rect, reserved.value);
  if (!sameRect(placed, playheadRect.value)) playheadRect.value = placed;
  const element = scroller.value;
  if (!keepInSight || playerState.value !== "playing" || rect === null || element === undefined) return;
  if (rect.y >= element.scrollTop && rect.y + rect.height <= element.scrollTop + element.clientHeight) return;
  scrollTo(Math.max(rect.y - FOLLOW_MARGIN, 0));
}

/** From the start of the cursor's bar; after a pause, from where it was, unless the cursor moved since. */
function play(): void {
  const player = engine?.player;
  if (player === undefined || player.state !== "paused") return;
  if (!resumable && session !== undefined) {
    const at = session.cursor;
    player.seek((at && player.tickOf(at.barId)) ?? 0);
  }
  resumable = false;
  stopped.value = false;
  keepInSight = true;
  player.play();
}

function pause(): void {
  if (engine?.player.state !== "playing") return;
  resumable = true;
  engine.player.pause();
}

function showStopped(): void {
  resumable = false;
  stopped.value = true;
  playingBar.value = null;
  playheadRect.value = null;
}

function stop(): void {
  if (engine === undefined || !playerUsable(engine.player.state)) return;
  showStopped();
  engine.player.stop();
}

function togglePlay(): void {
  if (playerState.value === "playing") pause();
  else play();
}

function onToolbar(action: () => void): void {
  action();
  focusScore();
}

function scrollTo(top: number): void {
  const element = scroller.value;
  if (element === undefined) return;
  element.scrollTop = top;
  ownScrollTop = element.scrollTop;
}

function onScroll(): void {
  const element = scroller.value;
  if (element === undefined) return;
  if (ownScrollTop !== null && Math.abs(element.scrollTop - ownScrollTop) < 1) return;
  keepInSight = false;
}

function reveal(): void {
  const element = scroller.value;
  const box = cursorRect.value;
  if (element === undefined || box === null) return;
  const margin = 80;
  if (box.y < element.scrollTop + margin) scrollTo(Math.max(box.y - margin, 0));
  else if (box.y + box.height > element.scrollTop + element.clientHeight - margin) scrollTo(box.y + box.height - element.clientHeight + margin);
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
  keepInSight = false;
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
  focusScore();
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
  focusScore();
}

function toggleParts(): void {
  if (partsOpen.value) {
    closeParts();
    return;
  }
  panelOpen.value = false;
  placeCursor();
  partsOpen.value = true;
}

function closeParts(): void {
  partsOpen.value = false;
  focusScore();
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
    resumable = false;
    if (!keepInSight || playerState.value !== "playing") reveal();
  });
  session.onHint((hint) => {
    notice.value = strings.score.hints[hint];
  });
  session.onEditText(openText);
  placeCursor();
  scroller.value?.focus();
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

/** Leaving the page with changes the server does not have: the browser asks first. */
function warnUnsaved(event: BeforeUnloadEvent): void {
  if (saver?.unsaved()) event.preventDefault();
}
window.addEventListener("beforeunload", warnUnsaved);

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
  jsonToDoc(fragmentToScore(details.fragment), doc);
  if (host.value === undefined) return;
  // The editor lays out on the page's own thread, bar by bar, as the edit views do (docs/adr/0003);
  // a device that only plays lays out in a worker, and a click sends playback there.
  engine = createAlphaTabEngine(host.value, {
    fontDirectory: "/font/",
    soundFont: "/soundfont/sonivox.sf3",
    useWorkers: !editable,
    seekOnClick: !editable,
    scale: 1,
  });
  sound = soundUpdates(engine.player, "a", updateLoop);
  engine.renderer.onRendered(() => {
    ready.value = true;
    updateOverlay();
  });
  playerState.value = engine.player.state;
  engine.player.onState((state) => {
    playerState.value = state;
    if (engine) showPlayback(engine.player.position.tick);
  });
  engine.player.onFinished(showStopped);
  engine.player.onPosition((position) => showPlayback(position.tick));
  draw({ kind: "structure" });
  stopObserving = observeScore(doc, onChange);
  if (editable && score.value !== null) {
    saver = createPhraseSaver({ id: details.id, revision: details.revision, name: details.name, fragment: details.fragment });
    saver.onState((state) => {
      saveState.value = state;
      saveError.value = state === "failed" && saver?.error != null ? errorText(saver.error) : null;
    });
    startEditing(score.value);
  } else focusScore();
});

onBeforeUnmount(() => {
  window.removeEventListener("beforeunload", warnUnsaved);
  hideFromTests();
  saver?.destroy();
  sound?.destroy();
  stopObserving?.();
  session?.destroy();
  engine?.destroy();
  doc.destroy();
});
</script>

<template>
  <NotFoundView v-if="notFound" />
  <template v-else>
    <AppHeader />
    <main class="phrase" :data-view="editable ? 'editable' : 'read'" :data-can-type="editable">
      <header class="phrase__toolbar">
        <RouterLink class="phrase__library" :to="{ name: 'phrases' }">{{ text.library }}</RouterLink>
        <h1 class="phrase__title" data-title>{{ name ?? (loadError ? strings.unknownError : strings.loading) }}</h1>
        <AppButton v-if="editable && name !== null" variant="ghost" size="sm" data-rename @click="openDialog('rename')">{{ text.rename }}</AppButton>
        <span v-if="editable && name !== null" class="phrase__save" :data-save="saveState">{{ text.save[saveState] }}</span>
        <PlayerControls v-if="name !== null" :state="playerState" :stopped="stopped" :bar="playingBar" @toggle="onToolbar(togglePlay)" @stop="onToolbar(stop)" @retry="onToolbar(() => engine?.player.retry())" />
        <div v-if="editable && name !== null" class="phrase__bars">
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
        <p v-if="!editable && name !== null" class="phrase__muted" data-desktop-only>{{ text.desktopOnly }}</p>
        <p v-if="notice" class="phrase__notice" role="status">
          <span>{{ notice }}</span>
          <button type="button" class="phrase__dismiss" @click="onToolbar(() => (notice = null))">{{ strings.score.dismiss }}</button>
        </p>
      </header>
      <p v-if="loadError" class="phrase__error" role="alert">{{ loadError }}</p>
      <div v-if="saveState === 'conflict'" class="phrase__banner" role="alert" data-conflict>
        <span>{{ errorText("revision_conflict") }}</span>
        <AppButton variant="ghost" size="sm" data-reload @click="emit('reload')">{{ text.reload }}</AppButton>
        <AppButton variant="primary" size="sm" data-save-as-new @click="openDialog('saveAsNew')">{{ text.saveAsNew }}</AppButton>
      </div>
      <p v-if="saveProblem" class="phrase__banner" role="alert" :data-save-problem="saveState">{{ saveProblem }}</p>
      <div class="phrase__body">
        <div
          ref="scroller"
          class="phrase__scroller"
          data-scroller
          tabindex="0"
          :aria-label="text.label"
          @keydown="onKey"
          @pointerdown="onPointer"
          @scroll.passive="onScroll"
        >
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
      </div>
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
      </template>
    </main>
  </template>
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
.phrase__title {
  margin: 0;
  font-size: 1.25rem;
  overflow-wrap: anywhere;
}
.phrase__save,
.phrase__muted {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.875rem;
}
.phrase__bars {
  display: flex;
  gap: 0.25rem;
}
.phrase__notice {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin: 0 0 0 auto;
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
</style>
