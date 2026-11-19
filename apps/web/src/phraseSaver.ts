// Saving a phrase from the phrase editor (docs/spec/phrases.md, 5.1). Once editing stops for a
// second, the whole fragment is put, from the revision the page has; a new name is patched at
// once. One request is on its way at a time: what is changed meanwhile is only remembered as the
// latest content, sent once the request is back and the revision taken from its answer.
// A 409 reads the phrase once: holding what was sent, or anything sent before it whose answer never
// came (lost on the way: the server may have written it), its revision is taken and nothing said;
// holding anything else, the phrase was changed elsewhere, and nothing more is sent (the page asks:
// reload, or save as a new phrase). When it cannot be read, nothing more is sent either until the
// member asks to check again. A 413 keeps the content here, the next edit sent again. Nothing here
// knows of the page or of Yjs.
import { type ErrorCode, phraseDetails, phraseRevision } from "@studio/contracts";
import { type BarsFragment, barsFragmentSchema } from "@studio/score-model";

import { ApiError, get, patchFor, putFor } from "./api";
import { saveAsPhrase } from "./savePhrase";

/** How long editing stops before the fragment is put. */
export const SAVE_DELAY_MS = 1000;
/** How long before the first try again, after the server could not be reached or failed itself; each next one waits twice as long. */
export const RETRY_DELAY_MS = 5000;
/** The longest wait between two tries again (a `Retry-After` may ask for longer). */
export const MAX_RETRY_DELAY_MS = 60_000;
/** How many times the page tries again by itself before it waits for the member (`retry`) or the next edit. */
export const MAX_RETRIES = 5;

/** What a phrase holds that the editor changes: its name and its fragment. */
export interface PhraseContent {
  name: string;
  fragment: BarsFragment;
}

/**
 * - `saved`: the server has what the page has.
 * - `waiting`: changed here, waiting for a second of quiet.
 * - `saving`: a request is on its way.
 * - `conflict`: changed elsewhere since the revision the page has; nothing more is sent.
 * - `unchecked`: refused for its revision (409), and the phrase could not be read to tell whether
 *   it was changed elsewhere; nothing more is sent until the member asks to check again (`retry`).
 * - `tooLarge`: refused for its size (413); sent again after the next edit.
 * - `failed`: not saved for another reason (`error`); tried again by itself while `retrying`
 *   (the server could not be reached, failed itself, or asked to wait), else after the next edit
 *   or `retry`.
 */
export type SaveState = "saved" | "waiting" | "saving" | "conflict" | "unchecked" | "tooLarge" | "failed";

export interface PhraseSaver {
  readonly state: SaveState;
  /** The code of the last refusal, while `failed` for one; null otherwise. */
  readonly error: ErrorCode | null;
  /** While `failed`: it is tried again by itself. */
  readonly retrying: boolean;
  /** The revision the server holds, as far as the page knows. */
  readonly revision: number;
  /** The content as it is here: the latest edit and name. */
  readonly content: PhraseContent;
  /** The fragment as it is now, after an edit: put once editing stops for `SAVE_DELAY_MS`. */
  edit(fragment: BarsFragment): void;
  /** A new name (trimmed already): patched at once, after any request on its way. */
  rename(name: string): void;
  /** Something done here has not reached the server: the page warns before it is left. */
  unsaved(): boolean;
  /**
   * Send what is left now, without waiting for its second of quiet (the page is being left). True
   * once the server has all of it; false as soon as it cannot: refused, changed elsewhere or not
   * known to be, out of reach.
   */
  flush(): Promise<boolean>;
  /** The member asks: `unchecked`, read the phrase again; `failed` or `tooLarge`, send again now. */
  retry(): void;
  onState(listener: (state: SaveState) => void): () => void;
  /** The content here as a new phrase of this name (`POST /api/phrases`); its id. Refusals throw (ApiError). */
  saveAsNew(name: string): Promise<string>;
  /** Nothing more is sent, and answers still on their way are ignored. */
  destroy(): void;
}

export interface PhraseSaverStart extends PhraseContent {
  id: string;
  /** The revision the content was read at. */
  revision: number;
}

/**
 * JSON with the keys of every object in alphabetical order: two contents are the same when theirs
 * are (docs/spec/phrases.md, 5.1).
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item,
  );
}

/** The content as the server would hold it, written canonically: null for a fragment it would refuse. */
function canonicalContent({ name, fragment }: PhraseContent): string | null {
  const parsed = barsFragmentSchema.safeParse(fragment);
  return parsed.success ? canonicalJson({ name, fragment: parsed.data }) : null;
}

/** A failure worth trying again by itself: the server could not be reached, failed itself, or asked to wait. */
function retryable(failure: unknown): boolean {
  return !(failure instanceof ApiError) || failure.status >= 500 || failure.status === 429;
}

/** Whether the server may have written what it was sent: no answer came, or one that tells nothing of it. */
function mayHaveLanded(failure: unknown): boolean {
  return !(failure instanceof ApiError) || failure.status >= 500;
}

/** States in which nothing is sent until the member does something. */
const STOPPED: ReadonlySet<SaveState> = new Set(["conflict", "unchecked"]);

export function createPhraseSaver(start: PhraseSaverStart): PhraseSaver {
  const path = `/api/phrases/${start.id}`;
  let revision = start.revision;
  /** What the server holds, as far as the page knows. */
  let saved: PhraseContent = { name: start.name, fragment: start.fragment };
  /** What the page has. Each edit is a new object: changed is not the same object as saved. */
  let latest: PhraseContent = saved;
  /**
   * What was sent from `revision` and may have been written without the page hearing of it (its
   * answer lost, or one that tells nothing), latest first: a 409 that finds one of them is not a
   * change made elsewhere.
   */
  let unconfirmed: PhraseContent[] = [];
  /** While a 409 is looked into, and while `unchecked`: what it was the answer to. */
  let toCheck: PhraseContent | null = null;
  let state: SaveState = "saved";
  let error: ErrorCode | null = null;
  let onItsWay = false;
  /** The wait (the second of quiet, or before trying again) is over: what is left is to be sent. */
  let due = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Tries again by itself since the server last took something. */
  let retries = 0;
  let retrying = false;
  let destroyed = false;
  const listeners = new Set<(state: SaveState) => void>();

  const changed = (): boolean => latest.fragment !== saved.fragment || latest.name !== saved.name;

  /** The state now, told to the listeners; `error` and `retrying` are set before a `failed` is. */
  function become(next: SaveState): void {
    if (next !== "failed") {
      error = null;
      retrying = false;
    }
    // `failed` is told again each time: whether it is tried again, and why, may have changed.
    if (next === state && next !== "failed") return;
    state = next;
    for (const listener of listeners) listener(next);
  }

  function onState(listener: (state: SaveState) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function wait(delay: number): void {
    clearTimeout(timer);
    timer = setTimeout(sendNow, delay);
  }

  /** Send now what is left, whatever wait it was in. */
  function sendNow(): void {
    clearTimeout(timer);
    timer = undefined;
    due = true;
    void send();
  }

  /** The server holds this content at this revision. */
  function took(content: PhraseContent, at: number): void {
    revision = at;
    saved = content;
    unconfirmed = [];
    retries = 0;
  }

  /** Go on after the server took something: what is left goes now, unless an edit made meanwhile still waits for its second of quiet. */
  function goOn(): void {
    if (!changed()) become("saved");
    else if (timer === undefined) due = true;
    else become("waiting");
    void send();
  }

  /** Send what is left, if its wait is over and nothing is on its way: the fragment first, then the name. */
  async function send(): Promise<void> {
    if (destroyed || onItsWay || !due || STOPPED.has(state)) return;
    due = false;
    if (!changed()) {
      become("saved");
      return;
    }
    const putting = latest.fragment !== saved.fragment;
    const sending: PhraseContent = putting ? { name: saved.name, fragment: latest.fragment } : { name: latest.name, fragment: saved.fragment };
    onItsWay = true;
    become("saving");
    let answered: number;
    try {
      answered = (
        putting
          ? await putFor(path, { fragment: sending.fragment, baseRevision: revision }, phraseRevision)
          : await patchFor(path, { name: sending.name, baseRevision: revision }, phraseRevision)
      ).revision;
    } catch (failure) {
      onItsWay = false;
      if (destroyed) return;
      if (failure instanceof ApiError && failure.status === 409) {
        toCheck = sending;
        await check();
        return;
      }
      if (mayHaveLanded(failure)) unconfirmed = [sending, ...unconfirmed];
      refused(failure);
      void send();
      return;
    }
    onItsWay = false;
    if (destroyed) return;
    took(sending, answered);
    goOn();
  }

  /**
   * After a 409: read the phrase. Holding what was sent, or something sent before it unconfirmed,
   * its revision is taken and saving goes on; holding anything else, it was changed elsewhere; not
   * read, nobody can tell yet.
   */
  async function check(): Promise<void> {
    const sent = toCheck;
    if (sent === null) return;
    onItsWay = true;
    become("saving");
    let held: { content: string | null; revision: number } | null = null;
    try {
      const details = await get(path, phraseDetails);
      held = { content: canonicalContent({ name: details.name, fragment: details.fragment }), revision: details.revision };
    } catch {
      // Not read: `unchecked` below.
    }
    onItsWay = false;
    if (destroyed) return;
    if (held === null) {
      become("unchecked");
      return;
    }
    toCheck = null;
    const { content: heldContent, revision: heldRevision } = held;
    const match = heldContent === null ? undefined : [sent, ...unconfirmed].find((content) => canonicalContent(content) === heldContent);
    if (match === undefined) {
      become("conflict");
      return;
    }
    took(match, heldRevision);
    goOn();
  }

  function refused(failure: unknown): void {
    if (failure instanceof ApiError && failure.status === 413) {
      become("tooLarge");
      return;
    }
    error = failure instanceof ApiError ? failure.code : null;
    retrying = retryable(failure) && retries < MAX_RETRIES;
    if (retrying) {
      retries += 1;
      const backoff = Math.min(RETRY_DELAY_MS * 2 ** (retries - 1), MAX_RETRY_DELAY_MS);
      const asked = failure instanceof ApiError ? failure.retryAfterMs : null;
      wait(asked ?? backoff);
    }
    become("failed");
  }

  return {
    get state() {
      return state;
    },
    get error() {
      return error;
    },
    get retrying() {
      return retrying;
    },
    get revision() {
      return revision;
    },
    get content() {
      return latest;
    },
    edit(fragment) {
      latest = { ...latest, fragment };
      if (STOPPED.has(state)) return;
      if (!onItsWay) become("waiting");
      wait(SAVE_DELAY_MS);
    },
    rename(name) {
      latest = { ...latest, name };
      if (!STOPPED.has(state)) sendNow();
    },
    unsaved() {
      return onItsWay || changed();
    },
    flush() {
      if (!onItsWay && !changed()) return Promise.resolve(true);
      if (destroyed || STOPPED.has(state)) return Promise.resolve(false);
      return new Promise((resolve) => {
        const stop = onState((now) => {
          if (now === "waiting" || now === "saving") return;
          stop();
          resolve(now === "saved");
        });
        sendNow();
      });
    },
    retry() {
      if (destroyed || onItsWay) return;
      if (state === "unchecked") void check();
      else if (state === "failed" || state === "tooLarge") sendNow();
    },
    onState,
    saveAsNew: (name) => saveAsPhrase(name, latest.fragment),
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      listeners.clear();
    },
  };
}
