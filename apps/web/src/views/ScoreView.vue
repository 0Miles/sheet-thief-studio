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
// Offline, the page keeps going, Yjs merging what was typed once it is back; a reconnection that
// finds the member's rights changed closes the score, for ScorePage to open it anew or leave it
// (docs/spec/collab.md, section 7). A score nobody may change here opens read-only (access.ts).
import { HocuspocusProvider } from "@hocuspocus/provider";
import { AppButton, AppConfirmDialog } from "@karyl-chan/ui";
import { type ClosedNotice, type CollabTicket, type Role, scoreDetails } from "@studio/contracts";
import { createEditorSession, decideView, type EditorSession, keyNameOf, type LocalPresence, pageEffectOf, type TextRequest, type View } from "@studio/score-editor";
import {
  barsWithContent,
  canAddPart,
  type Cursor,
  cursorAt,
  docToJson,
  type Flag,
  flagsOf,
  type FlagStop,
  type KeySignature,
  MAX_BEAT_TEXT,
  metaOf,
  nextFlag,
  observeScore,
  type PartKind,
  type PartPresetId,
  type PitchedClef,
  readScore,
  type RepeatChange,
  type ScoreChange,
  type ScoreJSON,
  stillAt,
  type TimeSignature,
} from "@studio/score-model";
import { createAlphaTabEngine, type PartMix, type Rect, type ScoreEngine, sharesChannels } from "@studio/score-render";
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { RouterLink } from "vue-router";
import * as Y from "yjs";

import { afterRoleChange, type Closing, openedView, type ReadOnlyReason, readOnlyReasonOf, roleCanType, ticketRefusal } from "../access";
import { ApiError, collabUrl, get, guestTicketFor, newCollabTicket, refusal } from "../api";
import { barPanelOf } from "../barPanel";
import AppHeader from "../components/AppHeader.vue";
import BarPanel from "../components/BarPanel.vue";
import DisplayControls from "../components/DisplayControls.vue";
import FlagControls from "../components/FlagControls.vue";
import InlineTextEntry from "../components/InlineTextEntry.vue";
import MixerControls from "../components/MixerControls.vue";
import PartPanel from "../components/PartPanel.vue";
import PlayerControls from "../components/PlayerControls.vue";
import TitleEditor from "../components/TitleEditor.vue";
import { canType, isNarrow, keyPlatform } from "../device";
import { type DisplayOptions, loadDisplay, loadNarrowPart, saveDisplay, saveNarrowPart, shownParts } from "../display";
import { measureEditView } from "../measureHook";
import { stopWhenClosed } from "../notices";
import { partMix, type PlaybackOptions, saveMix, savePlayback, type ScoreMix, startPlayback } from "../mixer";
import { clearOf, entryRect, FLAG_STROKE, flagMarksOf, type FlagMark, STRUCTURE_STROKE, structuralEnds, structureBoxesOf } from "../overlay";
import { joinPresence, localStateOf, membersOf, type Peer, type PeerMark, peerMarksOf, type PresenceLink, selectionBoxes, TAG } from "../presence";
import { strings } from "../strings";
import { type SoundUpdates, soundUpdates } from "../sound";
import { useSessionStore } from "../stores/session";
import type { RestoreTarget } from "../restore";
import { useScorePlayback } from "../scorePlayback";
import { exposeForTests } from "../testHook";
import NotFoundView from "./NotFoundView.vue";

/** One of the two: a member's score id, or a guest's link token; and what to say first, when the score was opened anew. */
const props = defineProps<{ id?: string; token?: string; notice?: string }>();
/** `closed`: the score is to be opened anew, or left; `stopped`: the server closed the connection for good, the page saying why. */
const emit = defineEmits<{ closed: [closing: Closing]; stopped: [] }>();
const text = strings.score;
const isGuest = props.token !== undefined;
/** Who is logged in here: their own other tabs are not listed among the members present. */
const account = useSessionStore();

/** What opening the score needs: its id, title and the role in it (null for a guest), and a ticket for every connection. */
interface Opening {
  scoreId: string;
  title: string;
  role: Role | null;
  ticket: () => Promise<string>;
}

/**
 * A member's score: a new ticket for every connection, reconnections included (ADR 0005), with
 * the role as it is now. The server closes the connections of a member whose rights changed, so
 * a reconnection is where the page learns of it: a session ended (401), a member removed or a
 * score deleted (404), a role that can no longer type, or now can, close the score before the
 * ticket is shown, so that nothing of this document reaches the server any more.
 */
async function asMember(id: string): Promise<Opening> {
  const details = await get(`/api/scores/${id}`, scoreDetails);
  let role = details.role;
  const ticket = async () => {
    let given: CollabTicket;
    try {
      given = await newCollabTicket(id);
    } catch (error) {
      const refusal = ticketRefusal(error);
      if (refusal !== null) close({ kind: refusal });
      throw error;
    }
    if (given.role !== role) {
      const said = text.roleChanged(strings.home.roles[given.role]);
      if (afterRoleChange(role, given.role) === "reopen") {
        close({ kind: "reopen", notice: said });
        throw new Error(`the role on this score is now ${given.role}: opened anew`);
      }
      // An Owner made an Editor by a transfer, or the other way: still typing, on the same document.
      role = given.role;
      notice.value = said;
    }
    return given.ticket;
  };
  return { scoreId: id, title: details.title, role, ticket };
}

const opening = ref<Opening | null>(null);
/** A guest's link stopped opening the score (revoked, or made anew) while the page was open. */
const gone = ref(false);
/** Why the server closed this tab's connection for good (its `closed` notice); null while it has not. */
const closedBecause = ref<ClosedNotice["reason"] | null>(null);

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
/** The browser says it is online. While it is not, the page is offline, whatever the provider is trying. */
const online = ref(navigator.onLine);
/** What the indicator shows (`data-sync`): offline throughout, while the browser is, and not only between the provider's attempts. */
const shownSync = computed(() => (online.value ? sync.value : "offline"));
/** Why nobody may change the score here, whatever their role; null while they may (access.ts). */
let readOnlyBecause: ReadOnlyReason | null = null;
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
const notice = ref<string | null>(props.notice ?? null);
const host = ref<HTMLElement>();
const scroller = ref<HTMLElement>();
/** The keyboard back on the score, where it is. */
function focusScore(): void {
  scroller.value?.focus({ preventScroll: true });
}
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
/** The keys of the toolbar's buttons of bars, as this platform names them (docs/spec/keymap.md, section 7). */
const barKeys = { insert: keyNameOf("insertBarBefore", keyPlatform()), remove: keyNameOf("deleteBars", keyPlatform()), panel: keyNameOf("barPanel", keyPlatform()) };
/** Where the bars a structural command works on are drawn, dashed over every part, out of the reserved areas. */
const structureRects = shallowRef<Rect[]>([]);
/** The panel of the cursor's bar is open (docs/spec/commands.md, section 6): the editable view only. */
const panelOpen = ref(false);
/** The other tabs on the score (docs/spec/views.md, section 8); never any for a guest, who takes no part in the presence. */
const peers = shallowRef<Peer[]>([]);
/** Where the other tabs' cursors, name tags and selections are drawn, out of the reserved areas. */
const peerMarks = shallowRef<PeerMark[]>([]);
/** The members present, each once however many tabs they have open; not oneself. */
const members = computed(() => membersOf(peers.value, account.me?.accountId ?? null));
/** The cursor and the selection as of the session's last word, for what is shown of them outside the overlay. */
const presence = shallowRef<LocalPresence>({ cursor: null, selection: null });
/** The areas no overlay may cover, as of the last drawing; each gets an invisible marker, for the e2e tests. */
const reserved = shallowRef<Rect[]>([]);
/** The box the text of a beat is typed in, while Enter has it open: what it asked for and where it is. */
const textEntry = shallowRef<{ request: TextRequest; rect: Rect } | null>(null);
const {
  playerState,
  stopped,
  playingBar,
  playheadRect,
  isFollowing,
  showPlayback,
  togglePlay,
  stop,
  retrySound,
  cursorMoved,
  stopFollowing,
  onScroll,
  reveal,
  attach: attachPlayer,
} = useScorePlayback({
  scroller,
  reserved: () => reserved.value,
  // The edit views play from the start of the cursor's bar (docs/spec/playback.md, section 4); the
  // Read view from where playback is.
  startTick: (player) => {
    if (!editing.value) return null;
    const at = session?.cursor ?? null;
    return (at && player.tickOf(at.barId)) ?? 0;
  },
  reading: () => reading.value,
});
/** The member's settings of every score, kept in this browser (docs/spec/playback.md, section 1). */
const playback = ref<PlaybackOptions>({ metronome: false, countIn: false, whilePlaying: "a" });
/** The member's mix and speed of this score, kept in this browser under its id. */
const mix = shallowRef<ScoreMix>({ parts: new Map(), speed: 1 });
/** The panel of the mixer is open, at the side of the score (in the narrow Read view, the drawer has it). */
const mixerOpen = ref(false);
/** Behaviour (b): what plays is the score before a change (docs/spec/views.md, section 10). */
const behind = ref(false);
/** When the sound is made again after a change of content (docs/spec/playback.md, section 3). */
let sound: SoundUpdates | undefined;

const doc = new Y.Doc();
let engine: ScoreEngine | undefined;
let provider: HocuspocusProvider | undefined;
let session: EditorSession | undefined;
/** The versions page is shown over this score, hidden under it (ScorePage). */
let aside = false;
/** An Owner or an Editor, whatever the view: they may restore a version here. */
const mayChange = (): boolean => opening.value?.role != null && roleCanType(opening.value.role);
/** This tab in the presence: a member's, once the provider is made. */
let presenceLink: PresenceLink | null = null;
let stopObserving: (() => void) | undefined;
const hideFromTests = exposeForTests({
  // Once open, as this page holds it: what was typed offline too.
  scoreJson: () => (stopObserving !== undefined ? docToJson(doc) : null),
  cursor: () => session?.cursor ?? null,
  flags: () => flags.value,
  player: () => engine?.player.settings() ?? null,
  writeMeta: (field, json) => metaOf(doc).set(field, JSON.parse(json)),
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
  // Cut only where it is under a reserved area: the boxes of the other bars of a system keep their height.
  selectionRects.value = selection === null ? [] : selectionBoxes(engine.renderer, selection, reserved.value);
  structureRects.value = structureBoxesOf(engine.renderer, structuralEnds(selection, at, panelOpen.value), reserved.value);
  updateLoop();
}

/**
 * Draw the other tabs again: when their presence changed, or after a drawing, their anchors
 * placed in the score as it is now (a beat another member removed, a bar deleted).
 */
function placePeers(): void {
  peerMarks.value = engine === undefined ? [] : peerMarksOf(engine.renderer, doc, peers.value, reserved.value);
}

/** Tell the other tabs where this one is: the view's mode, and in the edit views the cursor and the selection. */
function tellPresence(): void {
  if (presenceLink === null || view.value === null) return;
  // On the versions page, the score under it: reading, with no cursor (docs/spec/collab.md, 8.5).
  presenceLink.tell(localStateOf(aside ? "read" : view.value, session?.presence() ?? { cursor: null, selection: null }));
}

/**
 * The selection is the loop (docs/spec/playback.md, section 4): set again whenever the selection
 * moves or the sound changes, the ticks of a selection being those of the sound in place.
 */
function updateLoop(): void {
  if (engine === undefined || !editing.value) return;
  const selection = session?.selection ?? null;
  engine.player.setLoop(selection && engine.player.loopOf(selection));
}

/** What the mixer says of the loop: the bars of the selection; null in the Read view, which has none. */
const loopText = computed(() => {
  const json = score.value;
  if (!editing.value || json === null) return null;
  const selection = presence.value.selection;
  if (selection === null) return text.mixer.loopNone;
  const numberOf = (barId: string) => json.bars.findIndex((bar) => bar.id === barId) + 1;
  if (selection.kind === "beats") return text.mixer.loopBeats(numberOf(selection.barId));
  const [first, last] = [numberOf(selection.anchorBarId), numberOf(selection.focusBarId)].sort((a, b) => a - b);
  return text.mixer.loopBars(first!, last!);
});

/** The parts as the mixer lists them, and whether each shares its channels with another (playback.md, section 5). */
const mixerParts = computed(() => {
  const shared = sharesChannels(parts.value.map((part) => part.kind));
  return parts.value.map((part, index) => ({ id: part.id, name: part.name, shared: shared[index] === true }));
});

/** The toolbar's button: the mixer opens at the side of the score, alone there, or closes. */
function toggleMixer(): void {
  if (mixerOpen.value) {
    closeMixer();
    return;
  }
  panelOpen.value = false;
  partsOpen.value = false;
  placeCursor();
  mixerOpen.value = true;
}

function closeMixer(): void {
  mixerOpen.value = false;
  focusScore();
}

function onPartMix(partId: string, change: Partial<PartMix>): void {
  const next = { ...partMix(mix.value, partId), ...change };
  const mixed = new Map(mix.value.parts).set(partId, next);
  mix.value = { ...mix.value, parts: mixed };
  saveMix(scoreId, mix.value);
  const player = engine?.player;
  if (change.mute !== undefined) player?.setMute(partId, next.mute);
  if (change.solo !== undefined) player?.setSolo(partId, next.solo);
  if (change.volume !== undefined) player?.setVolume(partId, next.volume);
}

function onSpeed(speed: number): void {
  mix.value = { ...mix.value, speed };
  saveMix(scoreId, mix.value);
  engine?.player.setSpeed(speed);
}

function onPlayback(change: Partial<PlaybackOptions>): void {
  playback.value = { ...playback.value, ...change };
  savePlayback(playback.value);
  if (change.metronome !== undefined) engine?.player.setMetronome(change.metronome);
  if (change.countIn !== undefined) engine?.player.setCountIn(change.countIn);
  if (change.whilePlaying !== undefined) sound?.setMode(change.whilePlaying);
}


/** What the panel shows: the cursor's bar, the bars a selection names, its time signature and tempo; null while it is closed. */
const panel = computed(() => (panelOpen.value && score.value !== null ? barPanelOf(score.value, presence.value) : null));

/** F2, or the toolbar's button: the panel opens, the keyboard going to it, or closes, the keyboard back on the score. */
function togglePanel(): void {
  if (view.value !== "editable") return;
  if (panelOpen.value) closePanel();
  else {
    // One panel at the side of the score at a time.
    partsOpen.value = false;
    mixerOpen.value = false;
    panelOpen.value = true;
    placeCursor();
  }
}

/** The panel of the parts is open (docs/spec/commands.md, 7.1 and 7.2): the editable view only. */
const partsOpen = ref(false);
/** The part the member asked to delete, while the page asks them first; null otherwise. */
const deleting = ref<string | null>(null);
/** The title bar is being changed. */
const editingTitle = ref(false);

/** The title as shown: 「未命名」 for one read as empty (docs/spec/schema.md, section 2). */
const shownTitle = computed(() => {
  const title = score.value?.title ?? opening.value?.title;
  if (title === undefined) return loadError.value ? text.unavailable : strings.loading;
  return title === "" ? text.untitled : title;
});

/** Whether a part of each kind may still be added (docs/spec/commands.md, 7.1), as of the score drawn last. */
const canAdd = computed<Record<PartKind, boolean>>(() => {
  // Read again whenever the score changes.
  void score.value;
  return { fretted: canAddPart(doc, "fretted"), percussion: canAddPart(doc, "percussion"), pitched: canAddPart(doc, "pitched") };
});

/** What the page asks before a part is deleted: its name and how many bars it holds something in. */
const deletion = computed(() => {
  const json = score.value;
  const part = json?.parts.find((each) => each.id === deleting.value);
  return json && part ? { name: part.name || text.untitled, bars: barsWithContent(json, part.id) } : null;
});

// The part asked about is gone (another member deleted it): the question goes, and does not come
// back by itself if the part does (an undo).
watch(deletion, (asked) => {
  if (asked === null) deleting.value = null;
});

/** The toolbar's button: the panel of the parts opens or closes, the keyboard back on the score when it does. */
function toggleParts(): void {
  if (view.value !== "editable") return;
  if (partsOpen.value) closeParts();
  else {
    panelOpen.value = false;
    mixerOpen.value = false;
    placeCursor();
    partsOpen.value = true;
  }
}

function closeParts(): void {
  partsOpen.value = false;
  focusScore();
}

function onAddPart(preset: PartPresetId, tuning: number[] | undefined): void {
  session?.addPart(preset, tuning);
}

function onMovePart(partId: string, after: string | null): void {
  session?.movePart(partId, after);
}

/** Deleting a part asks first, deleting bars does not: a part takes a whole instrument with it (docs/spec/commands.md, 7.1). */
function confirmDelete(): void {
  const partId = deleting.value;
  closeDeletion();
  if (partId !== null) session?.deletePart(partId);
}

/** The question is answered, either way: the score has the keyboard again. */
function closeDeletion(): void {
  deleting.value = null;
  focusScore();
}

function onPartName(partId: string, name: string): void {
  session?.setPartName(partId, name);
}

function onTuning(partId: string, tuning: number[]): void {
  session?.setTuning(partId, tuning);
}

function onCapo(partId: string, capo: number): void {
  session?.setCapo(partId, capo);
}

function onProgram(partId: string, program: number): void {
  session?.setProgram(partId, program);
}

function onClef(partId: string, staff: number, clef: PitchedClef): void {
  session?.setClef(partId, staff, clef);
}

/** The title bar's form: each of the title and the artist that changed is one command. */
function applyTitle(title: string, artist: string): void {
  editingTitle.value = false;
  if (title !== score.value?.title) session?.setTitle(title);
  if (artist !== (score.value?.artist ?? "")) session?.setArtist(artist);
  focusScore();
}

function cancelTitle(): void {
  editingTitle.value = false;
  focusScore();
}

function closePanel(): void {
  panelOpen.value = false;
  placeCursor();
  focusScore();
}

function onTimeSig(timeSig: TimeSignature): void {
  session?.setTimeSig(timeSig);
}

function onTempo(tempo: number | null): void {
  session?.setTempo(tempo);
}

function onKeySig(keySig: KeySignature | null): void {
  session?.setKeySig(keySig);
}

function onSection(section: string | null): void {
  session?.setSection(section);
}

function onRepeat(change: RepeatChange): void {
  session?.setRepeat(change);
}

function onVoltas(passes: number[]): void {
  session?.setVoltas(passes);
}

function onAnacrusis(): void {
  session?.toggleAnacrusis();
}

/** Draw the overlay again after a drawing: the reserved areas, and where the flags are, change only then. */
function updateOverlay(): void {
  if (engine === undefined) return;
  reserved.value = engine.renderer.reservedRects();
  flagMarks.value = flagMarksOf(engine.renderer, flags.value, shown.value, reserved.value);
  placeCursor();
  placePeers();
  showPlayback(engine.player.position.tick);
}

/** A button of the toolbar did its work: the score has the keyboard again. */
function onToolbar(action: () => void): void {
  action();
  focusScore();
}

function draw(change: ScoreChange): void {
  if (engine === undefined) return;
  // A score of a newer schema, as synced at first or as a newer server migrated it since.
  const lockedBy = readOnlyReasonOf(doc);
  if (lockedBy !== null) lockReadOnly(lockedBy);
  const startedAt = performance.now();
  const { score: json, invalid } = readScore(doc);
  const readAt = performance.now();
  score.value = json;
  // From the whole score: a tie can be dangling for a change in the bar before (docs/spec/flags.md, section 3).
  flags.value = flagsOf(json, invalid);
  measurement.drawing(startedAt, readAt);
  forgetStaleStop();
  if (change.kind === "structure") {
    // A new set of bars or parts is a new model for the engine, which makes its sound itself.
    if (narrow.value) keepNarrowPart(json);
    shown.value = partsToShow(json);
    engine.renderer.setScore(json, shown.value);
    sound?.remade();
    keepCursorShown();
    return;
  }
  engine.renderer.patchBars(json, [...change.barIds]);
  // Another member's changes are heard as one's own are (docs/spec/playback.md, section 3).
  sound?.changed();
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

/** Enter on a beat: a box for its text opens below the cursor, out of the reserved areas (docs/spec/views.md, section 9). */
function openText(request: TextRequest): void {
  const at = cursorRect.value;
  if (at !== null) textEntry.value = { request, rect: entryRect(at, reserved.value) };
}

/** The box of a beat's text is closed, its text saved or not: the score has the keyboard again. */
function closeText(text: string | null): void {
  const entry = textEntry.value;
  textEntry.value = null;
  if (entry !== null && text !== null) session?.setText(entry.request.cursor, text);
  focusScore();
}

function startEditing(json: ScoreJSON): void {
  session = createEditorSession(doc, { platform: keyPlatform(), cursor: firstCursor(json, shown.value[0]), readOnly: view.value === "readOnlyEdit" });
  presence.value = session.presence();
  session.onPresence((now) => {
    presence.value = now;
    tellPresence();
    // A cursor that fell back to the start of the score may land in a part the member hid.
    keepCursorShown();
    forgetStaleStop();
    placeCursor();
    cursorMoved();
    // While playback is followed, the page stays with it (a click moves the cursor where the member looks).
    if (!isFollowing()) reveal(cursorRect.value);
  });
  session.onRefused(() => {
    notice.value = readOnlyBecause === null ? text.viewerCannotEdit : text.readOnly[readOnlyBecause];
  });
  session.onHint((hint) => {
    notice.value = text.hints[hint];
  });
  session.onEditText(openText);
  tellPresence();
  // The first drawing may be laid out already: the cursor it starts with is drawn now.
  placeCursor();
  // The score has the keyboard from the start.
  scroller.value?.focus();
}

function start(): void {
  if (stopObserving !== undefined || engine === undefined) return;
  draw({ kind: "structure" });
  stopObserving = observeScore(doc, draw);
  if (editing.value && score.value) {
    startEditing(score.value);
    return;
  }
  // The Read view of an Owner or an Editor (a device that cannot be typed on): a session with no
  // cursor, for a version restored here to be undone and done again by key (docs/spec/collab.md, 8.5).
  if (mayChange()) session = createEditorSession(doc, { platform: keyPlatform(), cursorless: true });
  // Space plays and pauses in the Read view too.
  focusScore();
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
  if (pageEffect === "barPanel") {
    event.preventDefault();
    togglePanel();
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
  // A button on the page (+bar) is not the score.
  if (event.target instanceof Element && event.target.closest("button") !== null) return;
  if (!editing.value || session === undefined || engine === undefined || host.value === undefined) return;
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

/**
 * Nobody may change the score here: a newer schema (docs/spec/schema.md, section 9), or the
 * server's `readOnly` notice (#109 hands its reason here). The edit view opens read-only, saying
 * why; one open for typing already is closed and opened anew, read-only, from the server's document.
 */
function lockReadOnly(reason: ReadOnlyReason): void {
  if (readOnlyBecause !== null) return;
  readOnlyBecause = reason;
  notice.value = text.readOnly[reason];
  if (view.value === "editable" && session !== undefined) close({ kind: "reopen", notice: text.readOnly[reason] });
  else if (view.value !== null) view.value = openedView(view.value, reason);
}

/** Closed once: the provider goes at once, so that nothing more of this document reaches the server; ScorePage does the rest. */
/** The provider goes, destroyed once the current call is over: not from within its own call (the ticket is asked for by it). */
function dropProvider(): void {
  const dropped = provider;
  provider = undefined;
  queueMicrotask(() => dropped?.destroy());
}

let closed = false;
function close(closing: Closing): void {
  if (closed) return;
  closed = true;
  // Its state goes from the others' awareness now: the score opened anew is another tab, with a
  // new document and a new client, and this one must not stay behind as a ghost.
  presenceLink?.leave();
  presenceLink = null;
  peers.value = [];
  peerMarks.value = [];
  dropProvider();
  emit("closed", closing);
}

/**
 * The server closed the connection for good (`stopWhenClosed`): the provider goes and no other
 * connects; the page says why and offers the score anew from the server, dropping what this tab
 * holds and the server never took.
 */
function closedByServer(reason: ClosedNotice["reason"]): void {
  closedBecause.value = reason;
  sync.value = "offline";
  dropProvider();
  // The versions page over the score can restore nothing any more: ScorePage shows the score, which says why.
  emit("stopped");
}

/** The score opened anew from the server's document, this tab's own dropped. */
function reloadFromServer(): void {
  close({ kind: "reopen", notice: text.closed.reloaded });
}

/**
 * The browser went offline: so is the page, at once, rather than once the provider hears nothing
 * for 30 seconds. Its socket is closed, and no other is tried until the browser is back online:
 * each attempt would only fail (and the browser log it as an error). What is typed from now on
 * waits for the next connection.
 */
function goOffline(): void {
  online.value = false;
  provider?.configuration.websocketProvider.disconnect();
}

/**
 * Back online: connect now. The provider's `connect` does nothing while its last socket is still
 * closing (it counts as connected until then), so it is also told to connect again once that
 * socket has closed.
 */
function goOnline(): void {
  online.value = true;
  const socket = provider?.configuration.websocketProvider;
  if (socket === undefined) return;
  socket.shouldConnect = true;
  void socket.connect();
}

/** Leaving the page with changes the server has not confirmed: the browser asks first (docs/spec/collab.md, section 7). */
function warnUnsynced(event: BeforeUnloadEvent): void {
  if (view.value === "editable" && provider !== undefined && provider.unsyncedChanges > 0) event.preventDefault();
}

window.addEventListener("offline", goOffline);
window.addEventListener("online", goOnline);
window.addEventListener("beforeunload", warnUnsynced);

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
    loadError.value = refusal(error);
    // Still an error of the page: it reaches the console, and the e2e tests' pageerror check.
    throw error;
  }
  if (host.value === undefined) return;
  view.value = openedView(decideView({ role: opened.role, isGuest, canType: canType() }), readOnlyBecause);
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
  // The player starts with the member's settings of this score, and the mixer shows them.
  const started = startPlayback(scoreId, engine.player);
  mix.value = started.mix;
  playback.value = started.playback;
  // The sound of a change is in place: so are the ticks the loop is set in.
  sound = soundUpdates(engine.player, playback.value.whilePlaying, updateLoop);
  sound.onBehind((now) => {
    behind.value = now;
  });
  engine.renderer.onRendered(() => {
    ready.value = true;
    updateOverlay();
  });
  attachPlayer(engine);
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
      dropProvider();
    },
    onSynced: () => {
      updateSync();
      start();
      // After a reconnection: the others see this tab again now, not when its state is renewed.
      presenceLink?.reconnected();
    },
    // The others' clocks go with their states, so that the ones the server sends again apply at once.
    onClose: () => presenceLink?.disconnected(),
    onUnsyncedChanges: updateSync,
    onStatus: ({ status }) => {
      if (status === "disconnected") sync.value = "offline";
      else if (status === "connecting") sync.value = "syncing";
    },
  });
  stopWhenClosed(provider, closedByServer);
  // A member's tab is in the presence from now on, in "read" mode with no cursor until the
  // score is open; a guest's provider has no awareness.
  if (provider.awareness !== null) {
    presenceLink = joinPresence(provider.awareness, (now) => {
      peers.value = now;
      placePeers();
    });
    tellPresence();
  }
});

// The view can turn read-only after the score opened (a newer schema): the mode follows it.
watch(view, tellPresence);

/**
 * Restore a version in this tab's document (docs/spec/collab.md, 8.5), for the versions page, which
 * shares it: in the edit view one types in, one command of the session, undone with Ctrl+Z like any
 * other; in the Read view of an Owner or an Editor (a device that cannot type), written straight.
 * Not before the score is open, in step with the server: written over a document still empty,
 * the score would come in afterwards beside the version.
 */
const restoreTarget: RestoreTarget = {
  canRestore() {
    if (closed || stopObserving === undefined || provider === undefined || readOnlyBecause !== null || session === undefined) return false;
    return view.value === "editable" || (view.value === "read" && mayChange());
  },
  replace(version) {
    return restoreTarget.canRestore() && session!.replaceScore(version);
  },
};

defineExpose({
  restoreTarget,
  /**
   * The versions page is shown over the score: playback stops and the question of a part's
   * deletion goes, as they would were the page left (the question is teleported to the body, out
   * of the hidden score); the others see this tab reading.
   */
  stepAside(): void {
    aside = true;
    stop();
    deleting.value = null;
    textEntry.value = null;
    tellPresence();
  },
  /** Back from the versions page: in the presence as before, and the score has the keyboard again. */
  stepBack(): void {
    aside = false;
    tellPresence();
    focusScore();
  },
});

onBeforeUnmount(() => {
  window.removeEventListener("offline", goOffline);
  window.removeEventListener("online", goOnline);
  window.removeEventListener("beforeunload", warnUnsynced);
  sound?.destroy();
  hideFromTests();
  measurement.stop();
  presenceLink?.leave();
  presenceLink = null;
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
        <TitleEditor v-if="editingTitle && score && view === 'editable'" :platform="keyPlatform()" :title="score.title" :artist="score.artist" @apply="applyTitle" @cancel="cancelTitle" />
        <template v-else>
          <h1 class="score__title" data-title>{{ shownTitle }}</h1>
          <span v-if="score?.artist" class="score__artist" data-artist>{{ score.artist }}</span>
          <AppButton v-if="view === 'editable' && score" variant="ghost" size="sm" data-edit-title :title="text.heading.editTitle" @click="editingTitle = true">
            {{ text.heading.edit }}
          </AppButton>
        </template>
        <span v-if="!loadError" class="score__sync" :data-sync="shownSync">{{ syncText[shownSync] }}</span>
        <template v-if="view && !narrow">
          <PlayerControls :state="playerState" :stopped="stopped" :bar="playingBar" @toggle="onToolbar(togglePlay)" @stop="onToolbar(stop)" @retry="onToolbar(retrySound)" />
          <DisplayControls :parts="parts" :hidden="display.hidden" :scale="display.scale" @hide="onHide" @scale="onScale" />
          <AppButton variant="ghost" size="sm" data-toggle-mixer :aria-pressed="mixerOpen" :title="text.mixer.openTitle" @click="toggleMixer">
            {{ text.mixer.open }}
          </AppButton>
        </template>
        <div v-if="view === 'editable'" class="score__bars">
          <AppButton variant="ghost" size="sm" data-insert-bar :title="text.bars.insertKey(barKeys.insert)" @click="onToolbar(() => session?.insertBar('before'))">
            {{ text.bars.insert }}
          </AppButton>
          <AppButton variant="ghost" size="sm" data-delete-bars :title="text.bars.removeKey(barKeys.remove)" @click="onToolbar(() => session?.deleteBars())">
            {{ text.bars.remove }}
          </AppButton>
          <AppButton variant="ghost" size="sm" data-toggle-panel :aria-pressed="panelOpen" :title="text.bars.panelKey(barKeys.panel)" @click="togglePanel">
            {{ text.bars.panel }}
          </AppButton>
          <AppButton variant="ghost" size="sm" data-toggle-parts :aria-pressed="partsOpen" :title="text.parts.panelTitle" @click="toggleParts">
            {{ text.parts.panel }}
          </AppButton>
        </div>
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
        <ul v-if="members.length > 0" class="score__members" data-members :aria-label="text.presence.members">
          <li v-for="member in members" :key="member.accountId" class="score__member" data-member :data-account="member.accountId" :data-mode="member.mode">
            <span class="score__member-dot" :style="{ background: member.color }"></span>
            <span>{{ member.displayName }}</span>
            <span v-if="member.mode === 'read'" class="score__member-mode">{{ text.presence.reading }}</span>
          </li>
        </ul>
        <RouterLink v-if="opening && !isGuest" class="score__settings" data-versions-link :to="{ name: 'score-versions', params: { id: opening.scoreId } }">{{ text.versions }}</RouterLink>
        <RouterLink v-if="opening && !isGuest" class="score__settings" :to="{ name: 'score-settings', params: { id: opening.scoreId } }">{{ text.settings }}</RouterLink>
        <p v-if="notice" class="score__notice" role="status">
          <span>{{ notice }}</span>
          <button type="button" class="score__dismiss" @click="dismissNotice">{{ text.dismiss }}</button>
        </p>
      </header>
      <p v-if="loadError" class="score__error" role="alert">{{ loadError }}</p>
      <p v-if="gone" class="score__error" role="alert">{{ strings.guest.gone }}</p>
      <p v-else-if="closedBecause" class="score__error" role="alert" data-closed>
        <span>{{ text.closed.reasons[closedBecause] }}</span>
        <button type="button" class="score__dismiss" @click="reloadFromServer">{{ text.closed.reload }}</button>
      </p>
      <!-- Once the score is open: before, there is nothing to keep editing. Typing goes on only in the edit view one types in. -->
      <p v-else-if="view && shownSync === 'offline'" class="score__banner" role="status" data-offline>
        {{ view === "editable" ? text.offline.editing : text.offline.reading }}
      </p>
      <p v-if="behind" class="score__banner score__banner--note" role="status" data-behind>{{ text.mixer.behind }}</p>
      <div class="score__body">
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
          <!-- Also in a score two members left with no bars, which the engine may not report drawn: +bar brings it back. -->
          <div v-if="view === 'editable' && (ready || score?.bars.length === 0)" class="score__end">
            <AppButton variant="ghost" size="sm" data-append-bar :title="text.bars.appendTitle" @click="onToolbar(() => session?.appendBar())">{{ text.bars.append }}</AppButton>
          </div>
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
            <rect
              v-for="(box, index) in structureRects"
              :key="`structure-${index}`"
              data-structure
              class="score__structure"
              :stroke-width="STRUCTURE_STROKE"
              :x="box.x"
              :y="box.y"
              :width="box.width"
              :height="box.height"
            />
            <template v-for="mark in peerMarks" :key="`peer-${mark.clientId}`">
              <rect
                v-for="(box, index) in mark.selection"
                :key="`peer-selection-${mark.clientId}-${index}`"
                data-peer-selection
                :data-client="mark.clientId"
                class="score__peer-selection"
                :fill="mark.color"
                :x="box.x"
                :y="box.y"
                :width="box.width"
                :height="box.height"
              />
              <rect
                v-if="mark.cursor"
                data-peer-cursor
                :data-client="mark.clientId"
                :data-account="mark.accountId"
                :data-mode="mark.mode"
                :data-bar="mark.at?.barId"
                :data-beat="mark.at?.beatId ?? ''"
                :class="['score__peer-cursor', `score__peer-cursor--${mark.mode}`]"
                :fill="mark.color"
                :x="mark.cursor.x"
                :y="mark.cursor.y"
                :width="mark.cursor.width"
                :height="mark.cursor.height"
                rx="2"
              />
            </template>
            <rect v-if="cursorRect" data-cursor :class="['score__cursor', { 'score__cursor--read': view === 'readOnlyEdit' }]" :x="cursorRect.x" :y="cursorRect.y" :width="cursorRect.width" :height="cursorRect.height" rx="2" />
          </svg>
          <!-- The names are what members typed: text only, never markup. -->
          <template v-for="mark in peerMarks" :key="`tag-${mark.clientId}`">
            <span
              v-if="mark.tag"
              data-name-tag
              :data-client="mark.clientId"
              :class="['score__name-tag', `score__name-tag--${mark.mode}`]"
              :style="{
                left: `${mark.tag.x}px`,
                top: `${mark.tag.y}px`,
                width: `${mark.tag.width}px`,
                height: `${mark.tag.height}px`,
                lineHeight: `${mark.tag.height}px`,
                fontSize: `${TAG.fontSize}px`,
                padding: `0 ${TAG.padding}px`,
                background: mark.color,
              }"
              >{{ mark.name }}</span
            >
          </template>
          <InlineTextEntry
            v-if="textEntry"
            :rect="textEntry.rect"
            :initial="textEntry.request.text"
            :max-length="MAX_BEAT_TEXT"
            :label="text.beatText"
            @close="closeText"
          />
        </div>
      </div>
      <BarPanel
        v-if="panel"
        :platform="keyPlatform()"
        v-bind="panel"
        @time-sig="onTimeSig"
        @tempo="onTempo"
        @key-sig="onKeySig"
        @section="onSection"
        @repeat="onRepeat"
        @voltas="onVoltas"
        @anacrusis="onAnacrusis"
        @close="closePanel"
      />
      <PartPanel
        v-if="partsOpen && view === 'editable' && score"
        :platform="keyPlatform()"
        :parts="score.parts"
        :can-add="canAdd"
        :current="presence.cursor?.partId ?? null"
        @add="onAddPart"
        @remove="deleting = $event"
        @move="onMovePart"
        @name="onPartName"
        @tuning="onTuning"
        @capo="onCapo"
        @program="onProgram"
        @clef="onClef"
        @close="closeParts"
      />
      <aside v-if="mixerOpen && view && !narrow" class="score__side" data-mixer-panel :aria-label="text.mixer.title">
        <header class="score__side-header">
          <h2 class="score__side-title">{{ text.mixer.title }}</h2>
          <AppButton variant="ghost" size="sm" @click="closeMixer">{{ text.mixer.close }}</AppButton>
        </header>
        <MixerControls :parts="mixerParts" :mix="mix" :playback="playback" :loop="loopText" @part="onPartMix" @speed="onSpeed" @playback="onPlayback" />
      </aside>
      </div>
      <AppConfirmDialog
        :visible="deletion !== null"
        :title="text.parts.confirmDelete.title"
        :message="deletion ? text.parts.confirmDelete.message(deletion.name, deletion.bars) : ''"
        :confirm-label="text.parts.confirmDelete.confirm"
        :cancel-label="text.parts.confirmDelete.cancel"
        :loading-label="strings.loading"
        confirm-variant="danger"
        data-confirm-delete-part
        @close="closeDeletion"
        @confirm="confirmDelete"
      />
      <!-- The narrow Read view: the player stays at the bottom, below the score, never over it. -->
      <section v-if="narrow && drawerOpen" class="score__drawer" data-drawer>
        <DisplayControls :hidden="display.hidden" :scale="display.scale" @scale="onScale" />
        <MixerControls :parts="mixerParts" :mix="mix" :playback="playback" :loop="null" @part="onPartMix" @speed="onSpeed" @playback="onPlayback" />
      </section>
      <footer v-if="narrow" class="score__playbar" data-playbar>
        <PlayerControls :state="playerState" :stopped="stopped" :bar="playingBar" @toggle="onToolbar(togglePlay)" @stop="onToolbar(stop)" @retry="onToolbar(retrySound)" />
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
  display: grid;
  gap: 0.75rem;
  /* The score keeps some room above it on a phone: the drawer scrolls instead. */
  max-height: 45vh;
  overflow-y: auto;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--border);
}
/* The mixer at the side of the score, as the panels of the edit view are. */
.score__side {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  width: 18rem;
  flex: none;
  padding: 0.75rem 1rem;
  border-left: 1px solid var(--border);
  background: var(--bg-surface);
  overflow-y: auto;
}
.score__side-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.score__side-title {
  margin: 0;
  font-size: 1rem;
}
.score__title {
  margin: 0;
  font-size: 1.25rem;
}
.score__artist {
  color: var(--text-muted);
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
/* Above the score, never over it: the score moves down while it is there. */
.score__banner {
  margin: 0;
  padding: 0.5rem 1.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-surface);
  color: var(--danger);
  font-size: 0.875rem;
}
.score__banner--note {
  color: var(--text-muted);
}
/* The score, and the panel of the cursor's bar at its side. */
.score__body {
  display: flex;
  flex: 1;
  min-height: 0;
}
.score__bars {
  display: flex;
  gap: 0.25rem;
}
.score__end {
  display: flex;
  justify-content: center;
  padding: 0.5rem 0 1.5rem;
}
.score__scroller {
  flex: 1;
  min-width: 0;
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
/* Dashed over every part: what is done there changes all of them. Its stroke is inside the rectangle (`structureBoxesOf`). */
.score__structure {
  fill: none;
  stroke: rgba(37, 99, 235, 0.8);
  stroke-dasharray: 6 4;
}
/* Filled only: a stroke would reach past the rectangle, into a reserved area. */
.score__cursor {
  fill: rgba(234, 88, 12, 0.4);
}
/* The read-only edit view's cursor: pale, nothing is typed there (docs/spec/views.md, section 4). */
.score__cursor--read {
  fill: rgba(234, 88, 12, 0.18);
}
/* The other members' marks, in their colour (`fill`): filled only, as one's own are. */
.score__peer-cursor--edit {
  fill-opacity: 0.45;
}
/* A member in a read-only view: pale. */
.score__peer-cursor--read {
  fill-opacity: 0.18;
}
.score__peer-selection {
  fill-opacity: 0.12;
}
/* Exactly the size `tagRect` gives it: the name cut off rather than the tag grown past it. */
.score__name-tag {
  position: absolute;
  z-index: 5;
  box-sizing: border-box;
  overflow: hidden;
  border-radius: 3px;
  color: #fff;
  white-space: nowrap;
  text-overflow: ellipsis;
  pointer-events: none;
}
.score__name-tag--read {
  opacity: 0.6;
}
.score__members {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 0.875rem;
}
.score__member {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.score__member-dot {
  width: 0.625rem;
  height: 0.625rem;
  border-radius: 50%;
}
.score__member-mode {
  color: var(--text-muted);
}
</style>
