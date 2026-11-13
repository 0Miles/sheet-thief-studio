// Editing commands: each changes the document in one transaction (one undo step) and returns
// where the cursor is afterwards. They never touch the DOM or the renderer.
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { nanoid } from "nanoid";
import * as Y from "yjs";

import {
  barsOf,
  COMMON_TIME,
  contentOf,
  emptyBarContent,
  KIND_DEFAULTS,
  LOCAL,
  MAIN_VOICE,
  metaOf,
  NOTE_VALUES,
  type NoteJSON,
  type NoteValue,
  ordered,
  type PartKind,
  partsOf,
  SCHEMA_VERSION,
  type Staff,
  staffCountOf,
  storedContentOf,
  type TimeSignature,
  type YBar,
  type YBeat,
  type YPart,
  type YVoice,
  voiceKeys,
} from "./schema";

/** Where a member is typing. `beatId` is null before the first beat of a voice. */
export interface Cursor {
  partId: string;
  barId: string;
  voice: string;
  beatId: string | null;
  /** Fretted parts: the string (1 is the highest). Other kinds: the staff position. */
  line: number;
}

/** Standard guitar tuning, from the first string: E4 B3 G3 D3 A2 E2. */
export const STANDARD_GUITAR = [64, 59, 55, 50, 45, 40];

function newId(): string {
  return nanoid(10);
}

function orderOf(item: Y.Map<unknown> | undefined): string | null {
  return (item?.get("order") as string | undefined) ?? null;
}

export function createScore(doc: Y.Doc, title: string): void {
  doc.transact(() => {
    metaOf(doc).set("schemaVersion", SCHEMA_VERSION);
    metaOf(doc).set("title", title);
  }, LOCAL);
}

export interface NewPart {
  name: string;
  kind: PartKind;
  tuning?: number[];
  capo?: number;
  /** Defaults to 25 (steel guitar), 0 for drums and pitched parts. */
  program?: number;
  /** Defaults to one staff: tablature, the drum staff, or the treble clef. */
  staves?: Staff[];
}

/** Add a part after the last one, with a place for the content of every bar. */
export function addPart(doc: Y.Doc, { name, kind, tuning, capo = 0, program = KIND_DEFAULTS[kind].program, staves = KIND_DEFAULTS[kind].staves }: NewPart): string {
  const id = newId();
  doc.transact(() => {
    const parts = partsOf(doc);
    const last = ordered(parts).at(-1);
    const part: YPart = new Y.Map();
    part.set("order", generateKeyBetween(last === undefined ? null : orderOf(parts.get(last)), null));
    part.set("name", name);
    part.set("kind", kind);
    part.set("tuning", tuning ?? (kind === "fretted" ? STANDARD_GUITAR : []));
    part.set("capo", capo);
    part.set("program", program);
    part.set("staves", staves.map((staff) => ({ ...staff })));
    const content = new Y.Map();
    for (const barId of barsOf(doc).keys()) content.set(barId, emptyBarContent(staves.length));
    part.set("content", content);
    parts.set(id, part);
  }, LOCAL);
  return id;
}

export interface NewBars {
  /** The bar the new ones follow; null puts them first. */
  after: string | null;
  count: number;
  /** Defaults to the time signature of the bar they follow (or precede), else 4/4. */
  timeSig?: TimeSignature;
}

/** Insert empty bars for every part; returns their ids in order. */
export function insertBars(doc: Y.Doc, { after, count, timeSig }: NewBars): string[] {
  const ids = Array.from({ length: count }, newId);
  doc.transact(() => {
    const bars = barsOf(doc);
    const order = ordered(bars);
    const index = after === null ? -1 : order.indexOf(after);
    const before = index < 0 ? undefined : bars.get(order[index] as string);
    const nextId = order[index + 1];
    const next = nextId === undefined ? undefined : bars.get(nextId);
    const keys = generateNKeysBetween(orderOf(before), orderOf(next), count);
    const signature = timeSig ?? ((before ?? next)?.get("timeSig") as TimeSignature | undefined) ?? COMMON_TIME;
    ids.forEach((id, i) => {
      const bar: YBar = new Y.Map();
      bar.set("order", keys[i]);
      bar.set("timeSig", { ...signature });
      bars.set(id, bar);
      // The member who makes a bar makes its place in every part, in the same transaction.
      for (const part of partsOf(doc).values()) contentOf(part).set(id, emptyBarContent(staffCountOf(part)));
    });
  }, LOCAL);
  return ids;
}

/**
 * Server only: give every part a place for every bar, and every bar every voice of the staves
 * of its part (a bar and a part made at the same time by two members miss each other). Clients
 * never repair, so that they cannot fight over it. Opens no transaction when nothing is missing.
 */
export function fillMissingContent(doc: Y.Doc): void {
  const gaps: (() => void)[] = [];
  for (const part of partsOf(doc).values()) {
    const content = storedContentOf(part);
    if (content === undefined) continue; // not a part that can be read: nothing to fill
    const staves = staffCountOf(part);
    const keys = voiceKeys(staves);
    for (const barId of barsOf(doc).keys()) {
      const voices: unknown = content.get(barId);
      if (voices === undefined) gaps.push(() => content.set(barId, emptyBarContent(staves)));
      else if (voices instanceof Y.Map) {
        for (const voice of keys) if (!voices.has(voice)) gaps.push(() => voices.set(voice, new Y.Array<YBeat>()));
      }
    }
  }
  if (gaps.length > 0) doc.transact(() => gaps.forEach((fill) => fill()));
}

function voiceAt(doc: Y.Doc, cursor: Cursor): YVoice | undefined {
  const part = partsOf(doc).get(cursor.partId);
  return part && contentOf(part).get(cursor.barId)?.get(cursor.voice);
}

function indexOfBeat(voice: YVoice, beatId: string | null): number {
  if (beatId === null) return -1;
  for (let i = 0; i < voice.length; i++) if (voice.get(i).get("id") === beatId) return i;
  return -1;
}

function beatAt(doc: Y.Doc, cursor: Cursor): YBeat | undefined {
  const voice = voiceAt(doc, cursor);
  if (voice === undefined) return undefined;
  const index = indexOfBeat(voice, cursor.beatId);
  return index < 0 ? undefined : voice.get(index);
}

export interface NewBeat {
  value: NoteValue;
  dots?: 0 | 1 | 2;
}

/**
 * Insert a rest after the beat of the cursor and move the cursor onto it: first when the cursor
 * is before the first beat, last when its beat is gone.
 */
export function insertBeat(doc: Y.Doc, cursor: Cursor, { value, dots = 0 }: NewBeat): Cursor {
  const voice = voiceAt(doc, cursor);
  if (voice === undefined) return cursor;
  const id = newId();
  doc.transact(() => {
    const at = indexOfBeat(voice, cursor.beatId);
    const beat: YBeat = new Y.Map();
    beat.set("id", id);
    beat.set("value", value);
    beat.set("dots", dots);
    beat.set("notes", new Y.Map());
    voice.insert(cursor.beatId === null ? 0 : at < 0 ? voice.length : at + 1, [beat]);
  }, LOCAL);
  return { ...cursor, beatId: id };
}

/** Put a fret on the string of the cursor, on its beat; null clears the string. */
export function setFret(doc: Y.Doc, cursor: Cursor, fret: number | null): Cursor {
  const beat = beatAt(doc, cursor);
  if (beat === undefined) return cursor;
  doc.transact(() => {
    const notes = beat.get("notes") as Y.Map<NoteJSON>;
    const key = `s${cursor.line}`;
    if (fret === null) notes.delete(key);
    else notes.set(key, { ...notes.get(key), fret });
  }, LOCAL);
  return cursor;
}

/**
 * Put a note on the beat of the cursor at the position named by `key` ("s3", "p38", "n61"),
 * replacing the one there; null removes it. The key is not checked against the kind of the part.
 */
export function setNote(doc: Y.Doc, cursor: Cursor, key: string, note: NoteJSON | null): Cursor {
  const beat = beatAt(doc, cursor);
  if (beat === undefined) return cursor;
  doc.transact(() => {
    const notes = beat.get("notes") as Y.Map<NoteJSON>;
    if (note === null) notes.delete(key);
    else notes.set(key, note);
  }, LOCAL);
  return cursor;
}

export function setDuration(doc: Y.Doc, cursor: Cursor, { value, dots = 0 }: NewBeat): Cursor {
  const beat = beatAt(doc, cursor);
  if (beat === undefined) return cursor;
  doc.transact(() => {
    beat.set("value", value);
    beat.set("dots", dots);
  }, LOCAL);
  return cursor;
}

/** Make the beat of the cursor one note value shorter (`step` 1) or longer (-1), keeping its dots. */
export function stepDuration(doc: Y.Doc, cursor: Cursor, step: 1 | -1): Cursor {
  const beat = beatAt(doc, cursor);
  if (beat === undefined) return cursor;
  const value = NOTE_VALUES[NOTE_VALUES.indexOf(beat.get("value") as NoteValue) + step];
  if (value === undefined) return cursor;
  doc.transact(() => {
    beat.set("value", value);
  }, LOCAL);
  return cursor;
}

/** The note value of the beat of the cursor, or undefined when it stands on none. */
export function valueAt(doc: Y.Doc, cursor: Cursor): NoteValue | undefined {
  return beatAt(doc, cursor)?.get("value") as NoteValue | undefined;
}

/** The cursor on the first beat of a bar of a part (before it when the bar is empty). */
export function cursorAt(doc: Y.Doc, partId: string, barId: string, line = 1): Cursor {
  const cursor: Cursor = { partId, barId, voice: MAIN_VOICE, beatId: null, line };
  const voice = voiceAt(doc, cursor);
  return voice && voice.length > 0 ? { ...cursor, beatId: voice.get(0).get("id") as string } : cursor;
}
