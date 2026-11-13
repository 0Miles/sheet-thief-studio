<script setup lang="ts">
// A score (`/scores/:id`), opened on /collab. On a device that can be typed on, members get the
// edit view: an Owner or an Editor types in it, a Viewer moves the cursor without changing
// anything (docs/spec/views.md, sections 1-4). Anyone else sees the score drawn read-only until
// the Read view comes (#32). Anyone who is not a member sees the 404 page.
import { HocuspocusProvider } from "@hocuspocus/provider";
import { type ScoreDetails, scoreDetails } from "@studio/contracts";
import { createEditorSession, decideView, type EditorSession, type View } from "@studio/score-editor";
import { cursorAt, docToJson, flagsOf, observeScore, type ScoreChange, type ScoreJSON } from "@studio/score-model";
import { createAlphaTabEngine, type Rect, type ScoreEngine } from "@studio/score-render";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import * as Y from "yjs";

import { ApiError, collabUrl, get, newCollabTicket } from "../api";
import AppHeader from "../components/AppHeader.vue";
import { canType } from "../device";
import { clearOf } from "../overlay";
import { errorText, strings } from "../strings";
import { exposeForTests } from "../testHook";
import NotFoundView from "./NotFoundView.vue";

const props = defineProps<{ id: string }>();
const text = strings.score;

const details = ref<ScoreDetails | null>(null);
const notFound = ref(false);
/** What to say when the score could not be asked for, for a reason other than not being found; null while all is well. */
const loadError = ref<string | null>(null);
/** The score is drawn: e2e tests wait for `data-ready` (docs/spec/testing.md, section 2). */
const ready = ref(false);
/** `syncing` while a change made here has not reached the server yet. */
const sync = ref<"syncing" | "synced" | "offline">("syncing");
const view = ref<View | null>(null);
/** One of the two edit views: the cursor, the keyboard and the overlay are there. */
const editing = computed(() => view.value === "editable" || view.value === "readOnlyEdit");
/** A notice for the member, shown above the score, never over it; null when there is none. */
const notice = ref<string | null>(null);
const host = ref<HTMLElement>();
const scroller = ref<HTMLElement>();
const score = shallowRef<ScoreJSON | null>(null);
/** Where the cursor is drawn, out of the reserved areas; null when its place is not drawn. */
const cursorRect = ref<Rect | null>(null);
/** The areas no overlay may cover; each gets an invisible marker, for the e2e tests. */
const reserved = shallowRef<Rect[]>([]);

const doc = new Y.Doc();
let engine: ScoreEngine | undefined;
let provider: HocuspocusProvider | undefined;
let session: EditorSession | undefined;
let stopObserving: (() => void) | undefined;
const hideFromTests = exposeForTests({
  scoreJson: () => (provider?.isSynced ? docToJson(doc) : null),
  cursor: () => session?.cursor ?? null,
  flags: () => (score.value ? flagsOf(score.value) : []),
});

/** Draw the overlay again: after a drawing, or when the cursor moved. */
function updateOverlay(): void {
  if (engine === undefined || !editing.value) return;
  const areas = engine.renderer.reservedRects();
  reserved.value = areas;
  const at = session?.cursor ?? null;
  const rect = at && engine.renderer.boundsOf(at);
  cursorRect.value = rect && clearOf(rect, areas);
}

/** Scroll so that the cursor is on screen, with some room around it. */
function reveal(): void {
  const element = scroller.value;
  const box = cursorRect.value;
  if (element === undefined || box === null) return;
  const margin = 80;
  if (box.y < element.scrollTop + margin) element.scrollTop = Math.max(box.y - margin, 0);
  else if (box.y + box.height > element.scrollTop + element.clientHeight - margin) element.scrollTop = box.y + box.height - element.clientHeight + margin;
}

function draw(change: ScoreChange): void {
  if (engine === undefined) return;
  const json = docToJson(doc);
  score.value = json;
  if (change.kind === "structure") engine.renderer.setScore(json);
  else engine.renderer.patchBars(json, [...change.barIds]);
}

/** The cursor a member starts with: the first place of the first bar of the first part. */
function firstCursor(json: ScoreJSON) {
  const part = json.parts[0];
  const bar = json.bars[0];
  // Fretted parts start on the top string, the others on the middle line (docs/spec/commands.md, section 2).
  return part && bar ? cursorAt(doc, part.id, bar.id, part.kind === "fretted" ? 1 : 4) : null;
}

function startEditing(json: ScoreJSON): void {
  session = createEditorSession(doc, { cursor: firstCursor(json), readOnly: view.value === "readOnlyEdit" });
  session.onPresence(() => {
    updateOverlay();
    reveal();
  });
  session.onRefused(() => {
    notice.value = text.viewerCannotEdit;
  });
  // The first drawing may be laid out already: the cursor it starts with is drawn now.
  updateOverlay();
  // The score has the keyboard from the start.
  scroller.value?.focus();
}

function start(): void {
  if (stopObserving !== undefined || engine === undefined) return;
  draw({ kind: "structure" });
  stopObserving = observeScore(doc, draw);
  if (editing.value && score.value) startEditing(score.value);
}

function onKey(event: KeyboardEvent): void {
  if (session === undefined || event.isComposing) return;
  if (session.press(event)) event.preventDefault();
}

/** A click on the score only moves the cursor (docs/spec/views.md, section 2). */
function onPointer(event: PointerEvent): void {
  if (session === undefined || engine === undefined || host.value === undefined) return;
  const box = host.value.getBoundingClientRect();
  const hit = engine.renderer.hitTest(event.clientX - box.left, event.clientY - box.top);
  if (hit) session.moveTo(hit);
}

function dismissNotice(): void {
  notice.value = null;
  scroller.value?.focus();
}

function updateSync(): void {
  if (provider === undefined) return;
  if (provider.isSynced && provider.unsyncedChanges === 0) sync.value = "synced";
  else if (sync.value !== "offline") sync.value = "syncing";
}

onMounted(async () => {
  let role: ScoreDetails["role"];
  try {
    details.value = await get(`/api/scores/${props.id}`, scoreDetails);
    role = details.value.role;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      notFound.value = true;
      return;
    }
    loadError.value = error instanceof ApiError ? errorText(error.code) : strings.unknownError;
    // Still an error of the page: it reaches the console, and the e2e tests' pageerror check.
    throw error;
  }
  if (host.value === undefined) return;
  view.value = decideView({ role, isGuest: false, canType: canType() });
  // The edit views lay out on the page's own thread: in place, bar by bar (docs/adr/0003).
  engine = createAlphaTabEngine(host.value, { fontDirectory: "/font/", soundFont: null, useWorkers: !editing.value });
  engine.renderer.onRendered(() => {
    ready.value = true;
    updateOverlay();
  });
  provider = new HocuspocusProvider({
    url: collabUrl(),
    name: props.id,
    document: doc,
    // A function, so that every connection, reconnections included, shows a new ticket (ADR 0005).
    token: () => newCollabTicket(props.id),
    onSynced: () => {
      updateSync();
      start();
    },
    onUnsyncedChanges: updateSync,
    onStatus: ({ status }) => {
      if (status === "disconnected") sync.value = "offline";
      else if (status === "connecting") sync.value = "syncing";
    },
  });
});

onBeforeUnmount(() => {
  hideFromTests();
  stopObserving?.();
  session?.destroy();
  provider?.destroy();
  engine?.destroy();
  doc.destroy();
});
</script>

<template>
  <NotFoundView v-if="notFound" />
  <template v-else>
    <AppHeader />
    <main class="score">
      <header class="score__toolbar">
        <h1 class="score__title">{{ score?.title ?? details?.title ?? (loadError ? text.unavailable : strings.loading) }}</h1>
        <span v-if="!loadError" class="score__sync" :data-sync="sync">{{ text.sync[sync] }}</span>
        <p v-if="notice" class="score__notice" role="status">
          <span>{{ notice }}</span>
          <button type="button" class="score__dismiss" @click="dismissNotice">{{ text.dismiss }}</button>
        </p>
      </header>
      <p v-if="loadError" class="score__error" role="alert">{{ loadError }}</p>
      <div
        ref="scroller"
        class="score__scroller"
        data-scroller
        :tabindex="editing ? 0 : undefined"
        :aria-label="text.label"
        @keydown="onKey"
        @pointerdown="onPointer"
      >
        <div class="score__page">
          <div ref="host" :data-ready="ready"></div>
          <svg v-if="editing" class="score__overlay" aria-hidden="true">
            <!-- Invisible: they only tell the e2e tests where no overlay may go. -->
            <rect v-for="(area, index) in reserved" :key="index" data-reserved :x="area.x" :y="area.y" :width="area.width" :height="area.height" fill="none" />
            <rect v-if="cursorRect" data-cursor class="score__cursor" :x="cursorRect.x" :y="cursorRect.y" :width="cursorRect.width" :height="cursorRect.height" rx="2" />
          </svg>
        </div>
      </div>
    </main>
  </template>
</template>

<style scoped>
.score {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 3rem);
}
.score__toolbar {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  padding: 0.5rem 1.5rem;
  border-bottom: 1px solid var(--border);
}
.score__title {
  margin: 0;
  font-size: 1.25rem;
}
.score__sync {
  color: var(--text-muted);
  font-size: 0.875rem;
}
.score__sync[data-sync="offline"] {
  color: var(--danger);
}
.score__notice {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  margin: 0 0 0 auto;
  font-size: 0.875rem;
}
.score__error {
  margin: 1rem 1.5rem;
  color: var(--danger);
}
.score__scroller {
  flex: 1;
  overflow: auto;
  outline: none;
  /* The score is drawn in black: keep its page white in either theme. */
  background: #fff;
}
.score__page {
  position: relative;
}
.score__overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  width: 100%;
  height: 100%;
  pointer-events: none;
}
/* Filled only: a stroke would reach past the rectangle, into a reserved area. */
.score__cursor {
  fill: rgba(234, 88, 12, 0.4);
}
</style>
