<script setup lang="ts">
// A score, opened on /collab: a member's by its id (`/scores/:id`), a guest's by its read-only
// link (`/s/:token`, the address staying the link's). On a device that can be typed on, members
// get the edit view: an Owner or an Editor types in it, a Viewer moves the cursor without
// changing anything (docs/spec/views.md, sections 1-4); both play from the cursor's bar and keep
// playback on screen (docs/spec/playback.md, section 4). Anyone else, guests included, gets the
// Read view (section 5): no cursor, a click sends playback there, and playback is always kept on
// screen; narrower than 768 px it shows one part at a time, its player at the bottom (section 7).
// The parts shown and the zoom are each member's own (section 6). Anyone who is not a member, and
// a link that opens nothing, gets the 404 page.
import { HocuspocusProvider } from "@hocuspocus/provider";
import { AppButton } from "@karyl-chan/ui";
import { type Role, scoreDetails } from "@studio/contracts";
import { createEditorSession, decideView, type EditorSession, keyNameOf, pageEffectOf, type View } from "@studio/score-editor";
import { type Cursor, cursorAt, docToJson, type Flag, flagsOf, type FlagStop, nextFlag, observeScore, readScore, type ScoreChange, type ScoreJSON, stillAt } from "@studio/score-model";
import { createAlphaTabEngine, type PlayerState, type Rect, type ScoreEngine } from "@studio/score-render";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { RouterLink } from "vue-router";
import * as Y from "yjs";

import { ApiError, collabUrl, get, guestTicketFor, newCollabTicket } from "../api";
import AppHeader from "../components/AppHeader.vue";
import DisplayControls from "../components/DisplayControls.vue";
import FlagControls from "../components/FlagControls.vue";
import PlayerControls from "../components/PlayerControls.vue";
import { canType, isNarrow, keyPlatform } from "../device";
import { type DisplayOptions, loadDisplay, loadNarrowPart, saveDisplay, saveNarrowPart, shownParts } from "../display";
import { measureEditView } from "../measureHook";
import { clearOf, FLAG_STROKE, flagMarksOf, type FlagMark, sameRect } from "../overlay";
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
/** One of the two edit views: the cursor and the keys of the score are there. */
const editing = computed(() => view.value === "editable" || view.value === "readOnlyEdit");
const reading = computed(() => view.value === "read");
/** The Read view of a window narrower than 768 px: one part at a time, the player at the bottom. */
const narrow = computed(() => reading.value && isNarrow());
/** The member's own display options of this score, as stored in this browser. */
const display = ref<DisplayOptions>({ hidden: [], scale: 1 });
/** The one part the narrow Read view shows; null until the score is there. */
const narrowPart = ref<string | null>(null);
/** The score's id, once it is opened (a guest's page learns it from the link): its display options are stored under it. */
let scoreId = "";
/** The parts the renderer was asked to show, in the score's order (`data-parts`, for the e2e tests). */
const shown = shallowRef<string[]>([]);
/** The narrow Read view's drawer, with the options that do not fit in its bars, is open. */
const drawerOpen = ref(false);
/** A notice for the member, shown above the score, never over it; null when there is none. */
const notice = ref<string | null>(null);
const host = ref<HTMLElement>();
const scroller = ref<HTMLElement>();
const score = shallowRef<ScoreJSON | null>(null);
/** The parts of the score, to choose from. */
const parts = computed(() => score.value?.parts ?? []);
/** Where the cursor is drawn, out of the reserved areas; null when its place is not drawn. */
const cursorRect = shallowRef<Rect | null>(null);
/** Where the selection is drawn, out of the reserved areas: a box for each system it is on. */
const selectionRects = shallowRef<Rect[]>([]);
/** What is wrong in the score, recomputed from the whole score at every change, never stored (docs/spec/flags.md, section 3). */
const flags = shallowRef<Flag[]>([]);
/** Where the flags of the parts shown are drawn, out of the reserved areas: a box on a bar, a mark on a note. */
const flagMarks = shallowRef<FlagMark[]>([]);
/** Where F8 or the toolbar's button last took the cursor, while it is still there. */
const flagStop = shallowRef<FlagStop | null>(null);
/** The key of the toolbar's next-flag button, as this platform names it. */
const nextFlagKey = keyNameOf("nextFlag", keyPlatform());
/** The areas no overlay may cover, as of the last drawing; each gets an invisible marker, for the e2e tests. */
const reserved = shallowRef<Rect[]>([]);
const playerState = ref<PlayerState>("loading");
/**
 * Not playing and not paused: never started, stopped, or played to the end. Never in the Read
 * view, which always shows where playback is (where a click sent it, the start after a stop).
 */
const stopped = ref(true);
/** The bar playback is in, counted from 1, as the toolbar shows it; null while stopped. */
const playingBar = ref<number | null>(null);
/** Where playback is drawn, out of the reserved areas; null while stopped. */
const playheadRect = shallowRef<Rect | null>(null);
/** The member paused, and the cursor has not moved since: playing goes on from there. */
let resumable = false;
/** Playback is to be kept on screen: from pressing play until the member presses a key or scrolls. */
let keepInSight = false;
/**
 * Playback is followed now: it plays and is kept on screen, so the page goes with it, not with the
 * cursor. The Read view follows it whenever it plays (docs/spec/views.md, section 5).
 */
const isFollowing = () => (keepInSight || reading.value) && playerState.value === "playing";
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
  flags: () => flags.value,
});
const measurement = measureEditView({
  doc,
  engine: () => engine,
  synced: isSynced,
  cursor: () => session?.cursor ?? null,
  moveCursor: (cursor) => session?.moveTo(cursor),
});

/** Draw the cursor and the selection again, where they are now: when they moved, or after a drawing. */
function placeCursor(): void {
  if (engine === undefined || !editing.value) return;
  const at = session?.cursor ?? null;
  const rect = at && engine.renderer.boundsOf(at);
  cursorRect.value = rect && clearOf(rect, reserved.value);
  const selection = session?.selection ?? null;
  selectionRects.value = selection === null ? [] : engine.renderer.boundsOfSelection(selection).map((box) => clearOf(box, reserved.value));
}

/** Draw the overlay again after a drawing: the reserved areas, and where the flags are, change only then. */
function updateOverlay(): void {
  if (engine === undefined) return;
  reserved.value = engine.renderer.reservedRects();
  flagMarks.value = flagMarksOf(engine.renderer, flags.value, shown.value, reserved.value);
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
 * paused, from where it was, unless the cursor moved since. The Read view plays from where
 * playback is.
 */
function play(): void {
  const player = engine?.player;
  if (player === undefined || player.state !== "paused") return;
  if (!resumable && editing.value) {
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
  // The Read view shows playback back at the start.
  if (reading.value) return;
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
  const startedAt = performance.now();
  const { score: json, invalid } = readScore(doc);
  measurement.drawing(startedAt);
  score.value = json;
  // From the whole score: a tie can be dangling for a change in the bar before (docs/spec/flags.md, section 3).
  flags.value = flagsOf(json, invalid);
  forgetStaleStop();
  if (change.kind === "structure") {
    // A new set of bars or parts is a new model for the engine, which makes its sound itself.
    if (narrow.value) keepNarrowPart(json);
    shown.value = partsToShow(json);
    engine.renderer.setScore(json, shown.value);
    keepCursorShown();
    return;
  }
  engine.renderer.patchBars(json, [...change.barIds]);
  // Another member's changes are heard as one's own are (docs/spec/playback.md, section 3).
  soundLater();
}

/** The first place of a bar of a part (the first bar when left out); null when either is not in the score. */
function firstCursor(json: ScoreJSON, partId: string | undefined, barId = json.bars[0]?.id): Cursor | null {
  const part = json.parts.find((each) => each.id === partId);
  // On the line the part starts on (`startLine`, docs/spec/commands.md, section 2).
  return part && barId ? cursorAt(doc, part.id, barId) : null;
}

/** The narrow Read view's one part, as long as the score has it; else the one chosen last here, or the first. */
function keepNarrowPart(json: ScoreJSON): void {
  const ids = json.parts.map((part) => part.id);
  if (narrowPart.value === null || !ids.includes(narrowPart.value)) narrowPart.value = loadNarrowPart(scoreId, ids);
}

/** The parts to show: the narrow Read view's one part, or all but those the member hid. */
function partsToShow(json: ScoreJSON): string[] {
  if (!narrow.value) return shownParts(json.parts.map((part) => part.id), display.value.hidden);
  return narrowPart.value === null ? [] : [narrowPart.value];
}

/** Show the parts the options say now, if they are not those shown already. */
function showChosenParts(): void {
  const json = score.value;
  if (engine === undefined || json === null) return;
  const next = partsToShow(json);
  if (next.join() === shown.value.join()) return;
  shown.value = next;
  engine.renderer.showParts(next);
  keepCursorShown();
}

/** A cursor in a part no longer shown goes to the same bar of the first part shown: it is typed on where it is seen. */
function keepCursorShown(): void {
  const at = session?.cursor;
  if (session === undefined || at == null || shown.value.includes(at.partId) || score.value === null) return;
  session.moveTo(firstCursor(score.value, shown.value[0], at.barId));
}

function saveOptions(): void {
  saveDisplay(scoreId, display.value);
}

function onHide(partId: string, hidden: boolean): void {
  onToolbar(() => {
    const rest = display.value.hidden.filter((id) => id !== partId);
    display.value = { ...display.value, hidden: hidden ? [...rest, partId] : rest };
    saveOptions();
    showChosenParts();
  });
}

function onScale(scale: number): void {
  onToolbar(() => {
    display.value = { ...display.value, scale };
    saveOptions();
    engine?.renderer.setScale(scale);
  });
}

/** The narrow Read view's part switcher: the part chosen is the one shown, now and the next time this score is opened here. */
function onNarrowPart(event: Event): void {
  const partId = (event.target as HTMLSelectElement).value;
  narrowPart.value = partId;
  saveNarrowPart(scoreId, partId);
  showChosenParts();
}

/** The cursor moved off the flag F8 stopped at, or the flag was fixed: its words go. */
function forgetStaleStop(): void {
  if (!stillAt(flagStop.value, session?.cursor ?? null, flags.value)) flagStop.value = null;
}

/**
 * F8, or the toolbar's button: the cursor goes to the next flag of the parts shown (docs/spec/
 * flags.md, section 4), and the page with it, as after any key.
 */
function goToNextFlag(): void {
  stopFollowing();
  if (session === undefined || score.value === null) return;
  const stop = nextFlag(score.value, flags.value, session.cursor, { stopped: flagStop.value, partIds: shown.value });
  if (stop === null) return;
  flagStop.value = stop;
  session.moveTo(stop.cursor);
}

function startEditing(json: ScoreJSON): void {
  session = createEditorSession(doc, { platform: keyPlatform(), cursor: firstCursor(json, shown.value[0]), readOnly: view.value === "readOnlyEdit" });
  session.onPresence(() => {
    forgetStaleStop();
    placeCursor();
    resumable = false;
    // While playback is followed, the page stays with it (a click moves the cursor where the member looks).
    if (!isFollowing()) reveal();
  });
  session.onRefused(() => {
    notice.value = text.viewerCannotEdit;
  });
  session.onHint((hint) => {
    notice.value = text.hints[hint];
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
  // Space plays and pauses in the Read view too.
  else scroller.value?.focus({ preventScroll: true });
}

function onKey(event: KeyboardEvent): void {
  const pageEffect = pageEffectOf(event, keyPlatform());
  if (pageEffect === "playPause") {
    event.preventDefault();
    if (!event.repeat) togglePlay();
    return;
  }
  if (pageEffect === "nextFlag") {
    event.preventDefault();
    goToNextFlag();
    return;
  }
  stopFollowing();
  const measured = measurement.key(event);
  const handled = session?.press(event) ?? false;
  if (handled) event.preventDefault();
  measured(handled);
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

/** Every change made here has reached the server. */
function isSynced(): boolean {
  return provider !== undefined && provider.isSynced && provider.unsyncedChanges === 0;
}

function updateSync(): void {
  if (provider === undefined) return;
  if (isSynced()) sync.value = "synced";
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
  scoreId = opened.scoreId;
  display.value = loadDisplay(scoreId);
  if (reading.value) stopped.value = false;
  // The edit views lay out on the page's own thread: in place, bar by bar (docs/adr/0003); the
  // Read view in a worker, and a click on it sends playback there.
  engine = createAlphaTabEngine(host.value, {
    fontDirectory: "/font/",
    soundFont: "/soundfont/sonivox.sf3",
    useWorkers: reading.value,
    seekOnClick: reading.value,
    scale: display.value.scale,
  });
  engine.renderer.onRendered(() => {
    ready.value = true;
    updateOverlay();
  });
  engine.player.onState((state) => {
    playerState.value = state;
    // Once the first sound is in, the Read view can show where playback is.
    if (engine) showPlayback(engine.player.position.tick);
  });
  engine.player.onFinished(showStopped);
  engine.player.onPosition((position) => showPlayback(position.tick));
  // After the page's own listeners: a drawing is measured once the cursor is drawn on it.
  measurement.watch(engine);
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
  measurement.stop();
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
    <main class="score" :data-view="view" :data-layout="view && (narrow ? 'narrow' : 'wide')">
      <header class="score__toolbar">
        <h1 class="score__title">{{ score?.title ?? opening?.title ?? (loadError ? text.unavailable : strings.loading) }}</h1>
        <span v-if="!loadError" class="score__sync" :data-sync="sync">{{ syncText[sync] }}</span>
        <template v-if="view && !narrow">
          <PlayerControls :state="playerState" :stopped="stopped" :bar="playingBar" @toggle="onToolbar(togglePlay)" @stop="onToolbar(stop)" />
          <DisplayControls :parts="parts" :hidden="display.hidden" :scale="display.scale" @hide="onHide" @scale="onScale" />
        </template>
        <FlagControls
          v-if="view"
          :count="flags.length"
          :can-go="editing"
          :shortcut="nextFlagKey"
          :stopped-at="flagStop?.flag.kind ?? null"
          @next="onToolbar(goToNextFlag)"
        />
        <label v-if="narrow && parts.length > 0" class="score__part">
          {{ text.display.part }}
          <select data-part-switcher :value="narrowPart ?? undefined" @change="onNarrowPart">
            <option v-for="part in parts" :key="part.id" :value="part.id">{{ part.name }}</option>
          </select>
        </label>
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
        :tabindex="view ? 0 : undefined"
        :aria-label="text.label"
        @keydown="onKey"
        @pointerdown="onPointer"
        @scroll.passive="onScroll"
      >
        <div class="score__page">
          <div ref="host" :data-ready="ready" :data-parts="shown.join(',')"></div>
          <svg v-if="view" class="score__overlay" aria-hidden="true">
            <!-- Invisible: they only tell the e2e tests where no overlay may go. -->
            <rect v-for="(area, index) in reserved" :key="index" data-reserved :x="area.x" :y="area.y" :width="area.width" :height="area.height" fill="none" />
            <rect
              v-for="(mark, index) in flagMarks"
              :key="`flag-${index}`"
              data-flag
              :data-kind="mark.kind"
              :class="['score__flag', `score__flag--${mark.shape}`]"
              :stroke-width="mark.shape === 'box' ? FLAG_STROKE : undefined"
              :x="mark.rect.x"
              :y="mark.rect.y"
              :width="mark.rect.width"
              :height="mark.rect.height"
            />
            <rect v-if="playheadRect" data-playhead class="score__playhead" :x="playheadRect.x" :y="playheadRect.y" :width="playheadRect.width" :height="playheadRect.height" />
            <rect
              v-for="(box, index) in selectionRects"
              :key="`selection-${index}`"
              data-selection
              class="score__selection"
              :x="box.x"
              :y="box.y"
              :width="box.width"
              :height="box.height"
            />
            <rect v-if="cursorRect" data-cursor class="score__cursor" :x="cursorRect.x" :y="cursorRect.y" :width="cursorRect.width" :height="cursorRect.height" rx="2" />
          </svg>
        </div>
      </div>
      <!-- The narrow Read view: the player stays at the bottom, below the score, never over it. -->
      <section v-if="narrow && drawerOpen" class="score__drawer" data-drawer>
        <DisplayControls :hidden="display.hidden" :scale="display.scale" @scale="onScale" />
      </section>
      <footer v-if="narrow" class="score__playbar" data-playbar>
        <PlayerControls :state="playerState" :stopped="stopped" :bar="playingBar" @toggle="onToolbar(togglePlay)" @stop="onToolbar(stop)" />
        <AppButton variant="ghost" size="sm" :aria-expanded="drawerOpen" @click="drawerOpen = !drawerOpen">
          {{ drawerOpen ? text.display.closeOptions : text.display.options }}
        </AppButton>
      </footer>
    </main>
  </template>
</template>

<style scoped>
.score {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 3rem);
  /* A phone's browser bars come and go: the player at the bottom stays in sight. */
  height: calc(100dvh - 3rem);
}
.score__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 1rem;
  padding: 0.5rem 1.5rem;
  border-bottom: 1px solid var(--border);
}
.score[data-layout="narrow"] .score__toolbar {
  padding: 0.5rem 1rem;
}
.score__part {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.875rem;
}
.score__playbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-top: 1px solid var(--border);
}
.score__drawer {
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--border);
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
/*
 * A box on a bar: its stroke (`FLAG_STROKE` wide) drawn inside the rectangle, which `flagMarksOf`
 * shrinks by half of it, so that it reaches no further than the rectangle kept clear of the
 * reserved areas.
 */
.score__flag--box {
  fill: none;
  stroke: rgba(220, 38, 38, 0.7);
}
.score__flag--box[data-kind="invalidContent"] {
  stroke: rgba(124, 58, 237, 0.7);
  stroke-dasharray: 4 3;
}
/* A mark on a note: filled only, as the cursor is. */
.score__flag--note {
  fill: rgba(220, 38, 38, 0.3);
}
/* Filled only, as the cursor is. */
.score__playhead {
  fill: rgba(37, 99, 235, 0.12);
}
/* Filled only, as the cursor is. */
.score__selection {
  fill: rgba(37, 99, 235, 0.18);
}
/* Filled only: a stroke would reach past the rectangle, into a reserved area. */
.score__cursor {
  fill: rgba(234, 88, 12, 0.4);
}
</style>
