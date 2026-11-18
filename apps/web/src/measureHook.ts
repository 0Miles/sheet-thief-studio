// `window.__studioMeasure`: what the measure suite (e2e/measure) does to the edit view and reads
// from it (docs/spec/testing.md, sections 2 and 4). Only in a build made with VITE_MEASURE=1: in
// any other build `measureEditView` gives a measurement that does nothing, the code below it is
// dead, and the bundle does not even hold the name.
import { changeBeatAt, type Cursor, cursorAt, docToJson, durationStep, insertBeat, LOCAL, type PartJSON, type ScoreJSON, setFret } from "@studio/score-model";
import type { NoteHead, PlayerPosition, PlayerState, Rect, RenderedEvent, RenderTimings, ScoreEngine } from "@studio/score-render";
import * as Y from "yjs";

/** One drawing of the score after a change, in milliseconds. */
export interface RenderSample extends RenderTimings {
  /** Reading the document into plain data, checked against the schema (`readScore`). */
  toJson: number;
  /**
   * Finding the flags of the whole score from that data (`flagsOf`). It also takes in handing
   * the data to the page (`score.value = json` in ScoreView.vue, just before), a shallow ref.
   */
  flags: number;
  partial: boolean;
  /** From the change to the layout being ready (`onRendered`). */
  total: number;
}

/** One key press, as times from `performance.now()`. */
export interface KeySample {
  key: string;
  /** When the browser made the event. */
  pressed: number;
  /** When the page began to handle it. */
  started: number;
  /** When the command had run and the cursor was drawn again. */
  handled: number;
  /** When the layout of the changed score was ready; null for a key that changes nothing. */
  rendered: number | null;
  /** When the piece of the page holding the cursor's bar was painted again; null as above. */
  painted: number | null;
  /** The first animation frame after all of the above. */
  frame: number;
  /** The frame after that one: by then the first has been shown. */
  nextFrame: number;
}

export interface StudioMeasureHook {
  /** The score is drawn and the cursor placed. */
  readonly ready: boolean;
  /** Every change made here has reached the server. */
  synced(): boolean;
  json(): ScoreJSON;
  /** Size in bytes of the whole Yjs state of the document. */
  stateSize(): number;
  /** Where the renderer puts the cursor (before the page moves it out of the reserved areas); null when there is none. */
  cursorRect(): Rect | null;
  /** Where the renderer drew the note heads of the cursor's beat. */
  noteHeads(): NoteHead[];
  /**
   * Put the cursor on a beat (or, with -1, in the append slot of an empty voice) of a bar of a
   * part, all by index; in `voice` (`"<staff>:<voice>"`), the first voice of the first staff when
   * left out.
   */
  placeCursor(part: number, bar: number, beat: number, line: number, voice?: string): Cursor | null;
  /** Change one fret in a bar of a part (by index) as a member would, and wait for the drawing. */
  editBar(part: number, bar: number): Promise<RenderSample>;
  /** Apply `count` edits spread over the score, in one transaction: drawn once, for the size of the document. */
  bulkEdit(count: number): void;
  renders: RenderSample[];
  keys: KeySample[];
  player: {
    state(): PlayerState;
    position(): PlayerPosition;
    /**
     * Regenerate the sound. Resolves with how long the page was busy making it (`generate`)
     * and how long until the player had taken it (`total`), in milliseconds.
     */
    reload(): Promise<{ generate: number; total: number }>;
    /** Every position the player reported, with when (`performance.now()`). */
    trace: { at: number; tick: number; state: PlayerState }[];
  };
  errors: string[];
}

declare global {
  interface Window {
    __studioMeasure?: StudioMeasureHook;
  }
}

/** What the edit view lets the measurements reach. */
export interface MeasuredView {
  doc: Y.Doc;
  engine(): ScoreEngine | undefined;
  /** Every change made here has reached the server. */
  synced(): boolean;
  cursor(): Cursor | null;
  moveCursor(cursor: Cursor): void;
}

/** Where the edit view tells the measurements what happens. */
export interface Measurement {
  /** The engine is made: its drawings, paintings and positions are watched from now on. */
  watch(engine: ScoreEngine): void;
  /**
   * A change goes to the renderer: reading the document for it began at `startedAt` and ended at
   * `readAt`, its flags were found since.
   */
  drawing(startedAt: number, readAt: number): void;
  /** A key of the score is about to be handled; returns what to call once it was, saying whether it did anything. */
  key(event: KeyboardEvent): (handled: boolean) => void;
  stop(): void;
}

const nothing = (): void => {};
const NO_MEASUREMENT: Measurement = { watch: nothing, drawing: nothing, key: () => nothing, stop: nothing };

/** The measurements of the edit view, in a measurement build only; in any other, nothing. */
export function measureEditView(view: MeasuredView): Measurement {
  if (import.meta.env.VITE_MEASURE !== "1") return NO_MEASUREMENT;
  return measuring(view);
}

/** A key whose change is not on the page yet: `drawing` is the number of the change it made. */
interface PendingKey {
  sample: KeySample;
  barId: string;
  drawing: number;
  timer?: ReturnType<typeof setTimeout>;
}

function measuring(view: MeasuredView): Measurement {
  const { doc } = view;
  let engine: ScoreEngine | undefined;
  let drawnOnce = false;
  /** Changes handed to the renderer and not drawn yet, oldest first, numbered in order. */
  const awaiting: { toJson: number; flags: number; startedAt: number; number: number }[] = [];
  let drawings = 0;
  let onNextRender: ((sample: RenderSample) => void) | undefined;
  const pendingKeys = new Set<PendingKey>();
  let editCount = 0;
  const unsubscribe: (() => void)[] = [];

  const hook: StudioMeasureHook = {
    get ready() {
      return drawnOnce && view.cursor() !== null;
    },
    synced: () => view.synced(),
    json: () => docToJson(doc),
    stateSize: () => Y.encodeStateAsUpdate(doc).byteLength,
    cursorRect() {
      const at = view.cursor();
      return at && engine ? engine.renderer.boundsOf(at) : null;
    },
    noteHeads() {
      const at = view.cursor();
      return at && engine ? engine.renderer.noteHeadsOf(at) : [];
    },
    placeCursor(part, bar, beat, line, voice = "0:0") {
      const at = partAndBar(part, bar);
      if (at === null) return null;
      const beatId = beat < 0 ? null : (at.part.content[at.barId]?.[voice]?.[beat]?.id ?? null);
      view.moveCursor({ partId: at.part.id, barId: at.barId, voice, beatId, at: beatId === null ? "after" : "on", line });
      return view.cursor();
    },
    editBar(part, bar) {
      const at = partAndBar(part, bar);
      if (at === null) return Promise.reject(new Error("no such part or bar"));
      return new Promise((resolve) => {
        onNextRender = resolve;
        editCount += 1;
        setFret(doc, cursorAt(doc, at.part.id, at.barId, 2), 1 + (editCount % 12));
      });
    },
    bulkEdit(count) {
      const json = docToJson(doc);
      const fretted = json.parts.filter((part) => part.kind === "fretted");
      let state = 7;
      const next = (below: number): number => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return Math.floor((state / 2 ** 32) * below);
      };
      doc.transact(() => {
        for (let i = 0; i < count; i++) {
          const part = fretted[next(fretted.length)];
          const bar = json.bars[next(json.bars.length)];
          if (part === undefined || bar === undefined) break;
          const beats = part.content[bar.id]?.["0:0"] ?? [];
          const beatId = beats[next(beats.length)]?.id ?? null;
          const at: Cursor = { partId: part.id, barId: bar.id, voice: "0:0", beatId, at: beatId === null ? "after" : "on", line: 1 + next(part.tuning.length) };
          const kind = next(10);
          if (kind < 7) setFret(doc, at, next(20));
          else if (kind < 9) changeBeatAt(doc, at, durationStep(next(2) === 0 ? 1 : -1));
          else insertBeat(doc, at, { value: 8 });
        }
      }, LOCAL);
    },
    renders: [],
    keys: [],
    player: {
      state: () => engine?.player.state ?? "loading",
      position: () => engine?.player.position ?? { tick: 0, endTick: 0, milliseconds: 0, endMilliseconds: 0 },
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

  /** A part and the id of a bar, both by index; null when there is no such part or bar. */
  function partAndBar(part: number, bar: number): { part: PartJSON; barId: string } | null {
    const json = docToJson(doc);
    const partJson = json.parts[part];
    const barId = json.bars[bar]?.id;
    return partJson === undefined || barId === undefined ? null : { part: partJson, barId };
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
    drawnOnce = true;
    const first = awaiting.shift();
    // Changes that arrived while the renderer was busy are drawn together, next.
    if (awaiting.length > 1) awaiting.splice(0, awaiting.length - 1);
    if (first === undefined) return;
    // This drawing shows every change up to the one that started it.
    for (const pending of pendingKeys) {
      if (pending.sample.rendered === null && pending.drawing <= first.number) pending.sample.rendered = performance.now();
    }
    const sample: RenderSample = { ...event.timings, toJson: first.toJson, flags: first.flags, partial: event.partial, total: performance.now() - first.startedAt };
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

  const onError = (event: ErrorEvent) => hook.errors.push(String(event.message));
  const onRejection = (event: PromiseRejectionEvent) => hook.errors.push(String(event.reason));
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  window.__studioMeasure = hook;

  return {
    watch(made) {
      engine = made;
      unsubscribe.push(
        made.renderer.onRendered(onRendered),
        made.renderer.onPainted(onPainted),
        made.player.onPosition((position) => {
          if (hook.player.trace.length < 20_000) hook.player.trace.push({ at: performance.now(), tick: position.tick, state: made.player.state });
        }),
      );
    },
    drawing(startedAt, readAt) {
      awaiting.push({ toJson: readAt - startedAt, flags: performance.now() - readAt, startedAt, number: ++drawings });
    },
    key(event) {
      const at = view.cursor();
      if (at === null) return nothing;
      // The key is watched from before its command runs: the edit view lays out on the page's own
      // thread, so the layout is finished by the time the command returns.
      const sample: KeySample = { key: event.key, pressed: event.timeStamp, started: performance.now(), handled: 0, rendered: null, painted: null, frame: 0, nextFrame: 0 };
      const pending: PendingKey = { sample, barId: at.barId, drawing: drawings + 1 };
      pendingKeys.add(pending);
      return (handled) => {
        if (handled) sample.handled = performance.now();
        if (!handled || drawings < pending.drawing) {
          pendingKeys.delete(pending);
          if (handled) finishKey(sample); // the key only moved the cursor
          return;
        }
        pending.barId = view.cursor()?.barId ?? at.barId;
        // The piece holding the bar is painted only when it is on screen: do not wait for ever.
        pending.timer = setTimeout(() => settleKey(pending), 1500);
      };
    },
    stop() {
      for (const off of unsubscribe) off();
      for (const pending of pendingKeys) clearTimeout(pending.timer);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      if (window.__studioMeasure === hook) delete window.__studioMeasure;
    },
  };
}
