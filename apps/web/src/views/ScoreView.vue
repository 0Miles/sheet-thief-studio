<script setup lang="ts">
// A score, opened on /collab: a member's by its id (`/scores/:id`), a guest's by its read-only
// link (`/s/:token`, the address staying the link's). On a device that can be typed on, members
// get the edit view: an Owner or an Editor types in it, a Viewer moves the cursor without
// changing anything (docs/spec/views.md, sections 1-4); both play from the cursor's bar and keep
// playback on screen (docs/spec/playback.md, section 4). Anyone else, guests included, sees the
// score drawn read-only until the Read view comes (#32). Anyone who is not a member, and a link
// that opens nothing, gets the 404 page.
import { HocuspocusProvider } from "@hocuspocus/provider";
import { AppButton } from "@karyl-chan/ui";
import { type Role, scoreDetails } from "@studio/contracts";
import { createEditorSession, decideView, type EditorSession, pageEffectOf, type View } from "@studio/score-editor";
import { type Cursor, cursorAt, docToJson, flagsOf, observeScore, type ScoreChange, type ScoreJSON } from "@studio/score-model";
import { createAlphaTabEngine, type PlayerState, type Rect, type ScoreEngine } from "@studio/score-render";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { RouterLink } from "vue-router";
import * as Y from "yjs";

import { ApiError, collabUrl, get, guestTicketFor, newCollabTicket } from "../api";
import AppHeader from "../components/AppHeader.vue";
import { canType, keyPlatform } from "../device";
import { clearOf, sameRect } from "../overlay";
import { errorText, strings } from "../strings";
import { exposeForTests } from "../testHook";
import NotFoundView from "./NotFoundView.vue";

/** One of the two: a member's score id, or a guest's link token. */
const props = defineProps<{ id?: string; token?: string }>();
const text = strings.score;
const isGuest = props.token !== undefined;

/** What opening the score needs: its id, title and the role in it (null for a guest), and a ticket for every connection. */
interface Opening {
  scoreId: string;
  title: string;
  role: Role | null;
  ticket: () => Promise<string>;
}

/** A member's score: a new ticket for every connection, reconnections included (ADR 0005). */
async function asMember(id: string): Promise<Opening> {
  const details = await get(`/api/scores/${id}`, scoreDetails);
  return { scoreId: id, title: details.title, role: details.role, ticket: () => newCollabTicket(id) };
}

const opening = ref<Opening | null>(null);
/** A guest's link stopped opening the score (revoked, or made anew) while the page was open. */
const gone = ref(false);

/**
 * A guest's: the link gives the score's id with a first ticket; every later connection asks the
 * link for a new one. A 404 then means the link is gone; any other failure (too many tickets, the
 * server restarting) is passing, and the provider tries again once its socket times out.
 */
async function asGuest(token: string): Promise<Opening> {
  const guest = await guestTicketFor(token);
  let first: string | null = guest.ticket;
  const ticket = async () => {
    const given = first;
    first = null;
    if (given !== null) return given;
    try {
      return (await guestTicketFor(token)).ticket;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) gone.value = true;
      throw error;
    }
  };
  return { scoreId: guest.scoreId, title: guest.title, role: null, ticket };
}
const syncText = isGuest ? strings.guest.sync : text.sync;
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
const cursorRect = shallowRef<Rect | null>(null);
/** The areas no overlay may cover, as of the last drawing; each gets an invisible marker, for the e2e tests. */
const reserved = shallowRef<Rect[]>([]);
const playerState = ref<PlayerState>("loading");
/** Not playing and not paused: never started, stopped, or played to the end. */
const stopped = ref(true);
/** The bar playback is in, counted from 1, as the toolbar shows it; null while stopped. */
const playingBar = ref<number | null>(null);
/** Where playback is drawn, out of the reserved areas; null while stopped. */
const playheadRect = shallowRef<Rect | null>(null);
/** The member paused, and the cursor has not moved since: playing goes on from there. */
let resumable = false;
/** Playback is to be kept on screen: from pressing play until the member presses a key or scrolls. */
let keepInSight = false;
/** Playback is followed now: it plays and is kept on screen, so the page goes with it, not with the cursor. */
const isFollowing = () => keepInSight && playerState.value === "playing";
/** Where the page itself last scrolled the score to (`scrollTo`): a scroll anywhere else is the member's. */
let ownScrollTop: number | null = null;
let soundTimer: ReturnType<typeof setTimeout> | undefined;

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

/** Draw the cursor again, where it is now: when it moved, or after a drawing. */
function placeCursor(): void {
  if (engine === undefined || !editing.value) return;
  const at = session?.cursor ?? null;
  const rect = at && engine.renderer.boundsOf(at);
  cursorRect.value = rect && clearOf(rect, reserved.value);
}

/** Draw the overlay again after a drawing: the reserved areas change only then. */
function updateOverlay(): void {
  if (engine === undefined || !editing.value) return;
  reserved.value = engine.renderer.reservedRects();
  placeCursor();
  showPlayback(engine.player.position.tick);
}

/** Room left above playback when the page scrolls to it. */
const FOLLOW_MARGIN = 40;

/** Show where playback is: the bar in the toolbar, the place on the page, kept on screen while following. */
function showPlayback(tick: number): void {
  if (engine === undefined || stopped.value) return;
  const played = engine.player.barAt(tick);
  if (played !== null) playingBar.value = played.index + 1;
  const rect = engine.renderer.boundsAtTick(tick);
  const placed = rect && clearOf(rect, reserved.value);
  // Most positions fall on the beat drawn already: the page is not drawn again for them.
  if (!sameRect(placed, playheadRect.value)) playheadRect.value = placed;
  const element = scroller.value;
  if (!isFollowing() || rect === null || element === undefined) return;
  const top = element.scrollTop;
  if (rect.y >= top && rect.y + rect.height <= top + element.clientHeight) return;
  scrollTo(Math.max(rect.y - FOLLOW_MARGIN, 0));
}

/**
 * Play from the start of the cursor's bar (docs/spec/playback.md, section 4); after the member
 * paused, from where it was, unless the cursor moved since.
 */
function play(): void {
  const player = engine?.player;
  if (player === undefined || player.state !== "paused") return;
  if (!resumable) {
    const at = session?.cursor ?? null;
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

/** Nothing plays any more: stopped, or at the end of the score, where the player is back at its start. */
function showStopped(): void {
  resumable = false;
  stopped.value = true;
  playingBar.value = null;
  playheadRect.value = null;
}

function stop(): void {
  if (engine === undefined || engine.player.state === "loading") return;
  showStopped();
  engine.player.stop();
}

function togglePlay(): void {
  if (playerState.value === "playing") pause();
  else play();
}

/** A button of the toolbar did its work: the score has the keyboard again. */
function onToolbar(action: () => void): void {
  action();
  scroller.value?.focus({ preventScroll: true });
}

/** The member looks over the score themselves: playback is no longer kept on screen, until they press play. */
function stopFollowing(): void {
  keepInSight = false;
}

/** Scroll the score, as the page: following playback, or showing the cursor. */
function scrollTo(top: number): void {
  const element = scroller.value;
  if (element === undefined) return;
  element.scrollTop = top;
  // As far as it could go: at the end of the score, less than asked.
  ownScrollTop = element.scrollTop;
}

/**
 * A scroll the page did not make is the member's, however they made it: the wheel, a touch, a
 * scroll bar (overlay scroll bars take no room, so a click on them cannot be told apart), keys.
 */
function onScroll(): void {
  const element = scroller.value;
  if (element === undefined) return;
  if (ownScrollTop !== null) {
    if (Math.abs(element.scrollTop - ownScrollTop) < 1) return;
    // The score got shorter, or the view taller, than where the page had put it: the browser
    // brought it back as far as it goes. Not the member.
    if (element.scrollTop < ownScrollTop && element.scrollTop >= element.scrollHeight - element.clientHeight - 1) {
      ownScrollTop = element.scrollTop;
      return;
    }
  }
  stopFollowing();
}

/** Changes are heard once typing stops for 400 ms (docs/spec/playback.md, section 3, behaviour (a)). */
const SOUND_DELAY = 400;

function soundLater(): void {
  clearTimeout(soundTimer);
  soundTimer = setTimeout(() => void engine?.player.load(), SOUND_DELAY);
}

/** Scroll so that the cursor is on screen, with some room around it. */
function reveal(): void {
  const element = scroller.value;
  const box = cursorRect.value;
  if (element === undefined || box === null) return;
  const margin = 80;
  if (box.y < element.scrollTop + margin) scrollTo(Math.max(box.y - margin, 0));
  else if (box.y + box.height > element.scrollTop + element.clientHeight - margin) scrollTo(box.y + box.height - element.clientHeight + margin);
}

function draw(change: ScoreChange): void {
  if (engine === undefined) return;
  const json = docToJson(doc);
  score.value = json;
  if (change.kind === "structure") {
    // A new set of bars or parts is a new model for the engine, which makes its sound itself.
    engine.renderer.setScore(json);
    return;
  }
  engine.renderer.patchBars(json, [...change.barIds]);
  if (editing.value) soundLater();
}

/** The cursor a member starts with: the first place of the first bar of the first part. */
function firstCursor(json: ScoreJSON): Cursor | null {
  const part = json.parts[0];
  const bar = json.bars[0];
  // Fretted parts start on the top string, the others on the middle line (docs/spec/commands.md, section 2).
  return part && bar ? cursorAt(doc, part.id, bar.id, part.kind === "fretted" ? 1 : 4) : null;
}

function startEditing(json: ScoreJSON): void {
  session = createEditorSession(doc, { platform: keyPlatform(), cursor: firstCursor(json), readOnly: view.value === "readOnlyEdit" });
  session.onPresence(() => {
    placeCursor();
    resumable = false;
    // While playback is followed, the page stays with it (a click moves the cursor where the member looks).
    if (!isFollowing()) reveal();
  });
  session.onRefused(() => {
    notice.value = text.viewerCannotEdit;
  });
  // The first drawing may be laid out already: the cursor it starts with is drawn now.
  placeCursor();
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
  if (pageEffectOf(event, keyPlatform()) === "playPause") {
    event.preventDefault();
    if (!event.repeat) togglePlay();
    return;
  }
  stopFollowing();
  if (session?.press(event)) event.preventDefault();
}

/** A click on the score only moves the cursor (docs/spec/views.md, section 2); playback goes on where it is. */
function onPointer(event: PointerEvent): void {
  // The main button only: not a right click for the context menu. Not on the scroller itself
  // either: that is its scroll bar, or the room around the page.
  if (event.button !== 0 || event.target === scroller.value) return;
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
  let opened: Opening;
  try {
    opened = isGuest ? await asGuest(props.token!) : await asMember(props.id!);
    opening.value = opened;
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
  view.value = decideView({ role: opened.role, isGuest, canType: canType() });
  // The edit views lay out on the page's own thread: in place, bar by bar (docs/adr/0003). They
  // play; the other views do not yet (#32).
  engine = createAlphaTabEngine(host.value, { fontDirectory: "/font/", soundFont: editing.value ? "/soundfont/sonivox.sf3" : null, useWorkers: !editing.value });
  engine.renderer.onRendered(() => {
    ready.value = true;
    updateOverlay();
  });
  engine.player.onState((state) => {
    playerState.value = state;
  });
  engine.player.onFinished(showStopped);
  engine.player.onPosition((position) => showPlayback(position.tick));
  provider = new HocuspocusProvider({
    url: collabUrl(),
    name: opened.scoreId,
    document: doc,
    // A function, so that every connection, reconnections included, shows a new ticket (ADR 0005).
    token: opened.ticket,
    // A guest has no presence (docs/spec/collab.md, section 5): it states none, and the server
    // sends it none. With no awareness coming in, a quiet score would send it nothing at all, and
    // the provider reconnects after 30 seconds of silence: it asks for the state every 15.
    ...(isGuest ? { awareness: null, forceSyncInterval: 15_000 } : {}),
    onAuthenticationFailed: () => {
      if (!gone.value) return;
      // Its link opens nothing any more: stop, rather than ask it for tickets again and again.
      sync.value = "offline";
      const dropped = provider;
      provider = undefined;
      queueMicrotask(() => dropped?.destroy());
    },
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
  clearTimeout(soundTimer);
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
        <h1 class="score__title">{{ score?.title ?? opening?.title ?? (loadError ? text.unavailable : strings.loading) }}</h1>
        <span v-if="!loadError" class="score__sync" :data-sync="sync">{{ syncText[sync] }}</span>
        <div v-if="editing" class="score__player" :data-player="playerState">
          <AppButton variant="primary" size="sm" :disabled="playerState === 'loading'" @click="onToolbar(togglePlay)">
            {{ playerState === "playing" ? text.player.pause : text.player.play }}
          </AppButton>
          <AppButton variant="ghost" size="sm" :disabled="playerState === 'loading' || stopped" @click="onToolbar(stop)">{{ text.player.stop }}</AppButton>
          <span v-if="playerState === 'loading'" class="score__playing">{{ text.player.loading }}</span>
          <span v-else-if="playingBar !== null" class="score__playing" data-playing-bar :data-bar="playingBar">{{ text.player.bar(playingBar) }}</span>
        </div>
        <RouterLink v-if="opening && !isGuest" class="score__settings" :to="{ name: 'score-settings', params: { id: opening.scoreId } }">{{ text.settings }}</RouterLink>
        <p v-if="notice" class="score__notice" role="status">
          <span>{{ notice }}</span>
          <button type="button" class="score__dismiss" @click="dismissNotice">{{ text.dismiss }}</button>
        </p>
      </header>
      <p v-if="loadError" class="score__error" role="alert">{{ loadError }}</p>
      <p v-if="gone" class="score__error" role="alert">{{ strings.guest.gone }}</p>
      <div
        ref="scroller"
        class="score__scroller"
        data-scroller
        :tabindex="editing ? 0 : undefined"
        :aria-label="text.label"
        @keydown="onKey"
        @pointerdown="onPointer"
        @scroll.passive="onScroll"
      >
        <div class="score__page">
          <div ref="host" :data-ready="ready"></div>
          <svg v-if="editing" class="score__overlay" aria-hidden="true">
            <!-- Invisible: they only tell the e2e tests where no overlay may go. -->
            <rect v-for="(area, index) in reserved" :key="index" data-reserved :x="area.x" :y="area.y" :width="area.width" :height="area.height" fill="none" />
            <rect v-if="playheadRect" data-playhead class="score__playhead" :x="playheadRect.x" :y="playheadRect.y" :width="playheadRect.width" :height="playheadRect.height" />
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
  /* The browser never scrolls on its own when the drawing changes size: any scroll the page did not make is the member's. */
  overflow-anchor: none;
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
.score__player {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.score__playing {
  color: var(--text-muted);
  font-size: 0.875rem;
  font-variant-numeric: tabular-nums;
}
/* Filled only, as the cursor is. */
.score__playhead {
  fill: rgba(37, 99, 235, 0.12);
}
/* Filled only: a stroke would reach past the rectangle, into a reserved area. */
.score__cursor {
  fill: rgba(234, 88, 12, 0.4);
}
</style>
