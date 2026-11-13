<script setup lang="ts">
// The M0 spike page: one score, drawn by the renderer, with the member's cursor on top and
// minimal keyboard entry. With a score id in the address the score is co-edited through the
// server, by a member who is logged in (a collab ticket for every connection); without one it
// lives in this page only (measurements and screenshots).
import { HocuspocusProvider } from "@hocuspocus/provider";
import { createEditorSession, type EditorSession } from "@studio/score-editor";
import {
  type Cursor,
  cursorAt,
  docToJson,
  flagsOf,
  insertBeat,
  metaOf,
  observeScore,
  type ScoreChange,
  type ScoreJSON,
  setFret,
  stepDuration,
} from "@studio/score-model";
import { createAlphaTabEngine, type PlayerState, type Rect, type RenderedEvent, type ScoreEngine } from "@studio/score-render";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { useRoute } from "vue-router";
import * as Y from "yjs";

import { collabUrl, newCollabTicket } from "../api";
import { keyPlatform } from "../device";
import { seedDemo, seedPerf } from "../spike/demoScores";
import type { KeySample, RenderSample, StudioHook } from "../spike/hook";
import { strings } from "../strings";

const route = useRoute();
const text = strings.spike;
const query = (name: string): string | undefined => {
  const value = route.query[name];
  return typeof value === "string" ? value : undefined;
};
const documentName = typeof route.params.name === "string" ? route.params.name : null;
const hasPlayer = query("player") !== "0";

const host = ref<HTMLElement>();
const scroller = ref<HTMLElement>();
const score = shallowRef<ScoreJSON | null>(null);
const rect = ref<Rect | null>(null);
const shown = ref("all");
const connection = ref<"local" | "connecting" | "connected" | "disconnected">(documentName === null ? "local" : "connecting");
const playerState = ref<PlayerState>("loading");
const flagCount = computed(() => (score.value ? flagsOf(score.value).length : 0));

const doc = new Y.Doc();
let engine: ScoreEngine | undefined;
let provider: HocuspocusProvider | undefined;
let session: EditorSession | undefined;
let stopObserving: (() => void) | undefined;
let started = false;
/** While true, changes to the document are not drawn (bulk edits for the size measurement). */
let silent = false;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

/** Changes handed to the renderer and not drawn yet, oldest first, numbered in order. */
const awaiting: { toJson: number; startedAt: number; number: number }[] = [];
let drawings = 0;
let onNextRender: ((sample: RenderSample) => void) | undefined;
/** A key whose change is not on the page yet: `drawing` is the number of the change it made. */
interface PendingKey {
  sample: KeySample;
  barId: string;
  drawing: number;
  timer?: ReturnType<typeof setTimeout>;
}
const pendingKeys = new Set<PendingKey>();

const hook: StudioHook = {
  ready: false,
  synced: () => provider === undefined || (provider.isSynced && provider.unsyncedChanges === 0),
  json: () => docToJson(doc),
  stateSize: () => Y.encodeStateAsUpdate(doc).byteLength,
  cursor: () => session?.cursor ?? null,
  cursorRect: () => rect.value,
  placeCursor(part, bar, beat, line) {
    const json = docToJson(doc);
    const partJson = json.parts[part];
    const barId = json.bars[bar]?.id;
    if (partJson === undefined || barId === undefined) return null;
    const beatId = beat < 0 ? null : (partJson.content[barId]?.["0:0"]?.[beat]?.id ?? null);
    moveCursor({ partId: partJson.id, barId, voice: "0:0", beatId, at: beatId === null ? "after" : "on", line });
    return session?.cursor ?? null;
  },
  editBar(part, bar) {
    const json = docToJson(doc);
    const partId = json.parts[part]?.id;
    const barId = json.bars[bar]?.id;
    if (partId === undefined || barId === undefined) return Promise.reject(new Error("no such part or bar"));
    return new Promise((resolve) => {
      onNextRender = resolve;
      editCount += 1;
      setFret(doc, cursorAt(doc, partId, barId, 2), 1 + (editCount % 12));
    });
  },
  bulkEdit(count) {
    silent = true;
    const json = docToJson(doc);
    const fretted = json.parts.filter((part) => part.kind === "fretted");
    let state = 7;
    const next = (below: number): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return Math.floor((state / 2 ** 32) * below);
    };
    for (let i = 0; i < count; i++) {
      const part = fretted[next(fretted.length)];
      const bar = json.bars[next(json.bars.length)];
      if (part === undefined || bar === undefined) break;
      const beats = part.content[bar.id]?.["0:0"] ?? [];
      const beatId = beats[next(beats.length)]?.id ?? null;
      const at: Cursor = { partId: part.id, barId: bar.id, voice: "0:0", beatId, at: beatId === null ? "after" : "on", line: 1 + next(part.tuning.length) };
      const kind = next(10);
      if (kind < 7) setFret(doc, at, next(20));
      else if (kind < 9) stepDuration(doc, at, next(2) === 0 ? 1 : -1);
      else insertBeat(doc, at, { value: 8 });
    }
    silent = false;
    draw({ kind: "structure" });
  },
  renders: [],
  keys: [],
  player: {
    state: () => engine?.player.state ?? "loading",
    position: () => engine?.player.position ?? { tick: 0, endTick: 0, milliseconds: 0, endMilliseconds: 0 },
    play: () => engine?.player.play(),
    pause: () => engine?.player.pause(),
    async reload() {
      const startedAt = performance.now();
      const loaded = engine?.player.load();
      const generate = performance.now() - startedAt;
      await loaded;
      return { generate, total: performance.now() - startedAt };
    },
    trace: [],
  },
  errors: [],
};
let editCount = 0;

function shownPartIds(json: ScoreJSON): string[] {
  const part = json.parts.find((item) => item.id === shown.value);
  return part ? [part.id] : json.parts.map((item) => item.id);
}

function updateRect(): void {
  const at = session?.cursor ?? null;
  rect.value = at && engine ? engine.renderer.boundsOf(at) : null;
}

/** Scroll so that the cursor is on screen, with some room around it. */
function reveal(): void {
  const view = scroller.value;
  const box = rect.value;
  if (view === undefined || box === null) return;
  const margin = 80;
  if (box.y < view.scrollTop + margin) view.scrollTop = Math.max(box.y - margin, 0);
  else if (box.y + box.height > view.scrollTop + view.clientHeight - margin) view.scrollTop = box.y + box.height - view.clientHeight + margin;
}

/** The session holds the cursor; the page draws it each time the session tells it moved. */
function moveCursor(next: Cursor | null): void {
  session?.moveTo(next);
  reveal();
}

/** Hand the score to the renderer after a change, and regenerate the sound once typing pauses. */
function draw(change: ScoreChange): void {
  if (silent || engine === undefined) return;
  const startedAt = performance.now();
  const json = docToJson(doc);
  awaiting.push({ toJson: performance.now() - startedAt, startedAt, number: ++drawings });
  score.value = json;
  if (change.kind === "structure") engine.renderer.setScore(json, shownPartIds(json));
  else engine.renderer.patchBars(json, [...change.barIds]);
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void engine?.player.load(), 400);
}

function finishKey(sample: KeySample): void {
  requestAnimationFrame(() => {
    sample.frame = performance.now();
    requestAnimationFrame(() => {
      sample.nextFrame = performance.now();
      hook.keys.push(sample);
    });
  });
}

function settleKey(pending: PendingKey): void {
  if (!pendingKeys.delete(pending)) return;
  clearTimeout(pending.timer);
  finishKey(pending.sample);
}

function onRendered(event: RenderedEvent): void {
  const first = awaiting.shift();
  // Changes that arrived while the renderer was busy are drawn together, next.
  if (awaiting.length > 1) awaiting.splice(0, awaiting.length - 1);
  updateRect();
  hook.ready = true;
  if (first === undefined) return;
  // This drawing shows every change up to the one that started it.
  for (const pending of pendingKeys) {
    if (pending.sample.rendered === null && pending.drawing <= first.number) pending.sample.rendered = performance.now();
  }
  const sample: RenderSample = { ...event.timings, toJson: first.toJson, partial: event.partial, total: performance.now() - first.startedAt };
  hook.renders.push(sample);
  const resolve = onNextRender;
  onNextRender = undefined;
  resolve?.(sample);
}

function onPainted(barIds: string[]): void {
  for (const pending of [...pendingKeys]) {
    if (pending.sample.rendered === null || !barIds.includes(pending.barId)) continue;
    pending.sample.painted = performance.now();
    settleKey(pending);
  }
}

function onKey(event: KeyboardEvent): void {
  const at = session?.cursor ?? null;
  if (at === null || session === undefined) return;
  // The key is watched from before its command runs: without a worker the renderer has
  // finished its layout by the time the command returns.
  const sample: KeySample = { key: event.key, pressed: event.timeStamp, started: performance.now(), handled: 0, rendered: null, painted: null, frame: 0, nextFrame: 0 };
  const pending: PendingKey = { sample, barId: at.barId, drawing: drawings + 1 };
  pendingKeys.add(pending);
  if (!session.press(event)) {
    pendingKeys.delete(pending);
    return;
  }
  event.preventDefault();
  reveal();
  sample.handled = performance.now();
  if (drawings < pending.drawing) {
    pendingKeys.delete(pending);
    finishKey(sample); // the key only moved the cursor
    return;
  }
  pending.barId = session.cursor?.barId ?? at.barId;
  // The piece holding the bar is painted only when it is on screen: do not wait for ever.
  pending.timer = setTimeout(() => settleKey(pending), 1500);
}

function onPointer(event: PointerEvent): void {
  const element = host.value;
  if (element === undefined || engine === undefined) return;
  const box = element.getBoundingClientRect();
  const hit = engine.renderer.hitTest(event.clientX - box.left, event.clientY - box.top);
  if (hit) moveCursor(hit);
}

function onShownChange(): void {
  if (score.value) engine?.renderer.showParts(shownPartIds(score.value));
}

function togglePlay(): void {
  if (engine === undefined) return;
  if (engine.player.state === "playing") engine.player.pause();
  else engine.player.play();
}

function start(): void {
  if (started || engine === undefined) return;
  started = true;
  if (metaOf(doc).get("schemaVersion") === undefined) {
    if (query("seed") === "perf") seedPerf(doc, Number(query("bars") ?? 100));
    else seedDemo(doc, { bars: Number(query("bars") ?? 12), parts: Number(query("parts") ?? 3) });
  }
  session = createEditorSession(doc, { platform: keyPlatform() }); // after the seed, so that undo cannot take the seed back
  session.onPresence(updateRect);
  const json = docToJson(doc);
  score.value = json;
  const wanted = Number(query("show"));
  shown.value = query("show") !== undefined && json.parts[wanted] ? (json.parts[wanted] as { id: string }).id : "all";
  awaiting.push({ toJson: 0, startedAt: performance.now(), number: ++drawings });
  engine.renderer.setScore(json, shownPartIds(json));
  stopObserving = observeScore(doc, draw);
  const part = json.parts.find((item) => shownPartIds(json).includes(item.id) && item.kind === "fretted") ?? json.parts[0];
  const bar = json.bars[0];
  if (part && bar) session.moveTo(cursorAt(doc, part.id, bar.id, 1));
}

onMounted(() => {
  if (host.value === undefined) return;
  window.__studio = hook;
  window.addEventListener("error", (event) => hook.errors.push(String(event.message)));
  window.addEventListener("unhandledrejection", (event) => hook.errors.push(String(event.reason)));
  engine = createAlphaTabEngine(host.value, {
    fontDirectory: "/font/",
    soundFont: hasPlayer ? "/soundfont/sonivox.sf3" : null,
    useWorkers: query("workers") !== "0",
    patch: query("patch") === "project" ? "project" : "replace",
    partialLayout: query("partial") !== "0",
    ...(query("window") ? { windowBars: Number(query("window")) } : {}),
  });
  engine.renderer.onRendered(onRendered);
  engine.renderer.onPainted(onPainted);
  engine.player.onState((state) => {
    playerState.value = state;
  });
  engine.player.onPosition((position) => {
    if (hook.player.trace.length < 20_000) hook.player.trace.push({ at: performance.now(), tick: position.tick, state: engine?.player.state ?? "loading" });
  });
  if (documentName === null) {
    start();
    return;
  }
  provider = new HocuspocusProvider({
    url: collabUrl(),
    name: documentName,
    document: doc,
    token: () => newCollabTicket(documentName),
    onSynced: start,
    onStatus: ({ status }) => {
      connection.value = status === "connected" ? "connected" : status === "connecting" ? "connecting" : "disconnected";
    },
  });
});

onBeforeUnmount(() => {
  clearTimeout(reloadTimer);
  stopObserving?.();
  session?.destroy();
  provider?.destroy();
  engine?.destroy();
  doc.destroy();
  delete window.__studio;
});
</script>

<template>
  <main class="spike">
    <header class="toolbar">
      <strong>{{ score?.title ?? text.title }}</strong>
      <span class="status" :data-state="connection">{{ text[connection] }}</span>
      <label>
        {{ text.parts }}
        <select v-model="shown" @change="onShownChange">
          <option value="all">{{ text.allParts }}</option>
          <option v-for="part in score?.parts ?? []" :key="part.id" :value="part.id">{{ part.name }}</option>
        </select>
      </label>
      <button v-if="hasPlayer" type="button" :disabled="playerState === 'loading'" @click="togglePlay">
        {{ playerState === "loading" ? text.playerLoading : playerState === "playing" ? text.pause : text.play }}
      </button>
      <span v-if="flagCount > 0" class="flags">{{ text.flags(flagCount) }}</span>
      <span class="keys">{{ text.keys }}</span>
    </header>
    <div ref="scroller" class="scroller" tabindex="0" :aria-label="text.scoreLabel" @keydown="onKey" @pointerdown="onPointer">
      <div class="page">
        <div ref="host" class="host"></div>
        <svg class="overlay" aria-hidden="true">
          <rect v-if="rect" class="cursor" :x="rect.x" :y="rect.y" :width="rect.width" :height="rect.height" rx="2" />
        </svg>
      </div>
    </div>
  </main>
</template>

<style scoped>
.spike {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--border, #d4d4d8);
  font-size: 0.875rem;
}

.status[data-state="connected"] {
  color: #15803d;
}

.status[data-state="disconnected"] {
  color: #b91c1c;
}

.flags {
  color: var(--accent-text);
}

.keys {
  color: var(--text-muted, #71717a);
  font-size: 0.75rem;
}

.scroller {
  flex: 1;
  overflow: auto;
  outline: none;
  /* The score is drawn in black: keep its page white in either theme. */
  background: #fff;
}

.page {
  position: relative;
}

.overlay {
  position: absolute;
  inset: 0;
  z-index: 5;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.cursor {
  fill: rgba(234, 88, 12, 0.28);
  stroke: #c2410c;
  stroke-width: 1.5;
}
</style>
