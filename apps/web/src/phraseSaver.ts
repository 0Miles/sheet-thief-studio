// Saving a phrase from the phrase editor (docs/spec/phrases.md, 5.1). Once editing stops for a
// second, the whole fragment is put, from the revision the page has; a new name is patched at
// once. One request is on its way at a time: what is changed meanwhile is only remembered as the
// latest content, sent once the request is back and the revision taken from its answer.
// A 409 reads the phrase once: holding what was sent already (an answer lost on the way, sent
// again), its revision is taken and nothing said; holding anything else, the phrase was changed
// elsewhere, and nothing more is sent (the page asks: reload, or save as a new phrase). A 413 keeps
// the content here, the next edit sent again. Nothing here knows of the page or of Yjs.
import { createdPhrase, type ErrorCode, phraseDetails, phraseRevision } from "@studio/contracts";
import { type BarsFragment, barsFragmentSchema } from "@studio/score-model";

import { ApiError, get, patchFor, postFor, putFor } from "./api";

/** How long editing stops before the fragment is put. */
export const SAVE_DELAY_MS = 1000;
/** How long before trying again, after the server could not be reached or failed itself. */
export const RETRY_DELAY_MS = 5000;

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
 * - `tooLarge`: refused for its size (413); sent again after the next edit.
 * - `failed`: not saved for another reason (`error`); tried again after a while when the
 *   server could not be reached or failed itself, else after the next edit.
 */
export type SaveState = "saved" | "waiting" | "saving" | "conflict" | "tooLarge" | "failed";

export interface PhraseSaver {
  readonly state: SaveState;
  /** The code of the last refusal, while `failed` for one; null otherwise. */
  readonly error: ErrorCode | null;
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
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item,
  );
}

/** The content as the server would hold it, written canonically: null for a fragment it would refuse. */
function canonicalContent({ name, fragment }: PhraseContent): string | null {
  const parsed = barsFragmentSchema.safeParse(fragment);
  return parsed.success ? canonicalJson({ name, fragment: parsed.data }) : null;
}

/** A failure that passes: the server could not be reached, or failed itself. */
function passing(failure: unknown): boolean {
  return !(failure instanceof ApiError) || failure.status >= 500 || failure.status === 429;
}

export function createPhraseSaver(start: PhraseSaverStart): PhraseSaver {
  const path = `/api/phrases/${start.id}`;
  let revision = start.revision;
  /** What the server holds, as far as the page knows. */
  let saved: PhraseContent = { name: start.name, fragment: start.fragment };
  /** What the page has. Each edit is a new object: changed is not the same object as saved. */
  let latest: PhraseContent = saved;
  let state: SaveState = "saved";
  let error: ErrorCode | null = null;
  let onItsWay = false;
  /** The wait (the second of quiet, or before trying again) is over: what is left is to be sent. */
  let due = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;
  const listeners = new Set<(state: SaveState) => void>();

  const changed = (): boolean => latest.fragment !== saved.fragment || latest.name !== saved.name;

  function become(next: SaveState): void {
    if (next !== "failed") error = null;
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener(next);
  }

  function wait(delay: number): void {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      due = true;
      void send();
    }, delay);
  }

  /** Send what is left, if its wait is over and nothing is on its way: the fragment first, then the name. */
  async function send(): Promise<void> {
    if (destroyed || onItsWay || !due || state === "conflict") return;
    due = false;
    if (!changed()) {
      become("saved");
      return;
    }
    const putting = latest.fragment !== saved.fragment;
    const sending: PhraseContent = putting ? { name: saved.name, fragment: latest.fragment } : { name: latest.name, fragment: saved.fragment };
    onItsWay = true;
    become("saving");
    let answered: number | null = null;
    let failure: unknown = null;
    try {
      answered = (
        putting
          ? await putFor(path, { fragment: sending.fragment, baseRevision: revision }, phraseRevision)
          : await patchFor(path, { name: sending.name, baseRevision: revision }, phraseRevision)
      ).revision;
    } catch (caught) {
      failure = caught;
      if (caught instanceof ApiError && caught.status === 409) answered = await alreadyHeld(sending);
    } finally {
      onItsWay = false;
    }
    if (destroyed) return;
    if (answered !== null) {
      revision = answered;
      saved = sending;
      // What is left goes now, unless an edit made meanwhile is still waiting for its second of quiet.
      if (!changed()) become("saved");
      else if (timer === undefined) due = true;
      else become("waiting");
    } else refused(failure);
    void send();
  }

  /** After a 409: the revision of the server when it holds what was sent, else null (changed elsewhere, or not read). */
  async function alreadyHeld(sending: PhraseContent): Promise<number | null> {
    try {
      const details = await get(path, phraseDetails);
      const held = canonicalContent({ name: details.name, fragment: details.fragment });
      if (held !== null && held === canonicalContent(sending)) return details.revision;
      become("conflict");
    } catch {
      // Not read: the content is sent again later, and the server says 409 again.
    }
    return null;
  }

  function refused(failure: unknown): void {
    if (state === "conflict") return;
    if (failure instanceof ApiError && failure.status === 413) {
      become("tooLarge");
      return;
    }
    become("failed");
    error = failure instanceof ApiError ? failure.code : null;
    if (passing(failure) || (failure instanceof ApiError && failure.status === 409)) wait(RETRY_DELAY_MS);
  }

  return {
    get state() {
      return state;
    },
    get error() {
      return error;
    },
    get revision() {
      return revision;
    },
    get content() {
      return latest;
    },
    edit(fragment) {
      latest = { ...latest, fragment };
      if (state === "conflict") return;
      if (!onItsWay) become("waiting");
      wait(SAVE_DELAY_MS);
    },
    rename(name) {
      latest = { ...latest, name };
      if (state === "conflict") return;
      clearTimeout(timer);
      timer = undefined;
      due = true;
      void send();
    },
    unsaved() {
      return onItsWay || changed();
    },
    onState(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async saveAsNew(name) {
      return (await postFor("/api/phrases", { name, fragment: latest.fragment }, createdPhrase)).id;
    },
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      listeners.clear();
    },
  };
}
