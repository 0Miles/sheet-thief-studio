// Editing commands: each changes the document in one transaction (one undo step) and returns
// where the cursor is afterwards. They never touch the DOM or the renderer.
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { nanoid } from "nanoid";
import * as Y from "yjs";

import {
  barsOf,
  contentOf,
  emptyBarContent,
  LOCAL,
  MAIN_VOICE,
  metaOf,
  type NoteJSON,
  type NoteValue,
  ordered,
  type PartKind,
  partsOf,
  SCHEMA_VERSION,
  type TimeSignature,
  type YBar,
  type YBeat,
  type YPart,
  type YVoice,
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

const COMMON_TIME: TimeSignature = { numerator: 4, denominator: 4 };

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
  program?: number;
}

/** Add a part after the last one, with a place for the content of every bar. */
export function addPart(doc: Y.Doc, { name, kind, tuning, capo = 0, program = 25 }: NewPart): string {
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
    const content = new Y.Map();
    for (const barId of barsOf(doc).keys()) content.set(barId, emptyBarContent());
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
      for (const part of partsOf(doc).values()) contentOf(part).set(id, emptyBarContent());
    });
  }, LOCAL);
  return ids;
}

/**
 * Server only: give every part a place for every bar (a bar and a part made at the same time by
 * two members miss each other). Clients never repair, so that they cannot fight over it.
 */
export function fillMissingContent(doc: Y.Doc): void {
  doc.transact(() => {
    for (const part of partsOf(doc).values()) {
      for (const barId of barsOf(doc).keys()) {
        if (contentOf(part).has(barId) === false) contentOf(part).set(barId, emptyBarContent());
      }
    }
  });
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

export function setDuration(doc: Y.Doc, cursor: Cursor, { value, dots = 0 }: NewBeat): Cursor {
  const beat = beatAt(doc, cursor);
  if (beat === undefined) return cursor;
  doc.transact(() => {
    beat.set("value", value);
    beat.set("dots", dots);
  }, LOCAL);
  return cursor;
}

/** The cursor on the first beat of a bar of a part (before it when the bar is empty). */
export function cursorAt(doc: Y.Doc, partId: string, barId: string, line = 1): Cursor {
  const cursor: Cursor = { partId, barId, voice: MAIN_VOICE, beatId: null, line };
  const voice = voiceAt(doc, cursor);
  return voice && voice.length > 0 ? { ...cursor, beatId: voice.get(0).get("id") as string } : cursor;
}
