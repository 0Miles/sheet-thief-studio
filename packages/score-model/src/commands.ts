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
  beatSchema,
  NOTE_VALUES,
  type NoteJSON,
  type NoteValue,
  noteValueSchema,
  ordered,
  type PartKind,
  partKindOf,
  partsOf,
  SCHEMA_VERSION,
  type Staff,
  staffCountOf,
  contentMapOf,
  type TimeSignature,
  type Tuplet,
  tupletSchema,
  type YBar,
  type YBeat,
  type YPart,
  type YVoice,
  voiceKeys,
} from "./schema";

/**
 * Where a member is typing (docs/spec/commands.md, section 2). On a beat (`at: "on"`), or in the
 * append slot of its voice (`at: "after"`): there `beatId` is the anchor, the last beat of the
 * voice when the cursor came there, and null when the voice was empty. Typing in the append slot
 * puts the new beat right after the anchor, so that two members typing in the same bar each keep
 * their beats together (docs/adr/0002).
 */
export interface Cursor {
  partId: string;
  barId: string;
  /** "staff:voice". */
  voice: string;
  beatId: string | null;
  at: "on" | "after";
  /** Fretted parts: the string (1 is the highest). Other kinds: the staff position. */
  line: number;
}

/**
 * A stretch the cursor extends over, inside one part (docs/spec/commands.md, section 4): beats
 * of one voice of one bar, or bars with all their voices. The anchor is where it started, the
 * focus follows the cursor.
 */
export type Selection =
  | { kind: "beats"; partId: string; barId: string; voice: string; anchorBeatId: string; focusBeatId: string }
  | { kind: "bars"; partId: string; anchorBarId: string; focusBarId: string };

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
    const content = contentMapOf(part);
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

/** The beat the cursor stands on; none in the append slot. */
function beatAt(doc: Y.Doc, cursor: Cursor): YBeat | undefined {
  if (cursor.at !== "on") return undefined;
  const voice = voiceAt(doc, cursor);
  if (voice === undefined) return undefined;
  const index = indexOfBeat(voice, cursor.beatId);
  return index < 0 ? undefined : voice.get(index);
}

/** The duration of a beat: its note value, dots and tuplet. */
export interface NewBeat {
  value: NoteValue;
  dots?: 0 | 1 | 2;
  tuplet?: Tuplet;
}

/** What a beat gets when there is no beat to take its duration from. */
const QUARTER: NewBeat = { value: 4 };

/** The duration of a beat as stored; undefined when it cannot be read. */
export function durationOf(beat: YBeat): NewBeat | undefined {
  const value = noteValueSchema.safeParse(beat.get("value"));
  const dots = beatSchema.shape.dots.safeParse(beat.get("dots"));
  const stored = beat.get("tuplet");
  const tuplet = tupletSchema.safeParse(stored);
  if (!value.success || !dots.success || (stored !== undefined && !tuplet.success)) return undefined;
  return { value: value.data, dots: dots.data, ...(tuplet.success ? { tuplet: tuplet.data } : {}) };
}

/** Where a beat made at the cursor goes: its voice, its index there, and the beat it takes its duration from. */
interface BeatPlace {
  voice: YVoice;
  index: number;
  durationFrom: YBeat | undefined;
}

/**
 * Where a beat made at the cursor goes: on a beat, just before it, as long as it; in the append
 * slot, just after the anchor, as long as the anchor (first and a quarter in an empty voice; when
 * the anchor is gone, after the last beat and as long as it, where the cursor settles).
 * Undefined when the cursor's beat or voice is gone.
 */
function placeFor(doc: Y.Doc, cursor: Cursor): BeatPlace | undefined {
  const voice = voiceAt(doc, cursor);
  if (voice === undefined) return undefined;
  const found = indexOfBeat(voice, cursor.beatId);
  if (cursor.at === "on") return found < 0 ? undefined : { voice, index: found, durationFrom: voice.get(found) };
  if (cursor.beatId === null) return { voice, index: 0, durationFrom: undefined };
  const anchor = found < 0 ? voice.length - 1 : found;
  return { voice, index: anchor + 1, durationFrom: anchor < 0 ? undefined : voice.get(anchor) };
}

/**
 * Make a beat at the cursor, in one transaction (one undo step), and move the cursor onto it: a
 * rest of `duration` (else as long as its place says), then `fill` puts its notes on it.
 */
function makeBeat(doc: Y.Doc, cursor: Cursor, place: BeatPlace, duration?: NewBeat, fill?: (notes: Y.Map<NoteJSON>) => void): Cursor {
  const { value, dots = 0, tuplet } = duration ?? (place.durationFrom && durationOf(place.durationFrom)) ?? QUARTER;
  const id = newId();
  doc.transact(() => {
    const beat: YBeat = new Y.Map();
    const notes = new Y.Map<NoteJSON>();
    beat.set("id", id);
    beat.set("value", value);
    beat.set("dots", dots);
    if (tuplet !== undefined) beat.set("tuplet", { ...tuplet });
    beat.set("notes", notes);
    place.voice.insert(place.index, [beat]);
    fill?.(notes);
  }, LOCAL);
  return { ...cursor, beatId: id, at: "on" };
}

/**
 * Insert a rest before the beat of the cursor, or append one in the append slot, and move the
 * cursor onto it. It lasts `duration`, else as long as the beat of the cursor or the anchor,
 * else a quarter (docs/spec/commands.md, 5.1 and 5.2). Changes nothing when the cursor's beat is
 * gone.
 */
export function insertBeat(doc: Y.Doc, cursor: Cursor, duration?: NewBeat): Cursor {
  const place = placeFor(doc, cursor);
  return place === undefined ? cursor : makeBeat(doc, cursor, place, duration);
}

/**
 * Write a note at the cursor, one command: on its beat, or in the append slot on a new beat made
 * there (as `insertBeat` makes it), the cursor then on that beat. `write` gets the note stored
 * at `key` and returns the new one, or null to remove it; removing makes no beat.
 */
function writeNote(doc: Y.Doc, cursor: Cursor, key: string, write: (stored: NoteJSON | undefined) => NoteJSON | null): Cursor {
  if (cursor.at === "after") {
    const note = write(undefined);
    const place = placeFor(doc, cursor);
    if (note === null || place === undefined) return cursor;
    return makeBeat(doc, cursor, place, undefined, (notes) => notes.set(key, note));
  }
  const beat = beatAt(doc, cursor);
  if (beat === undefined) return cursor;
  const notes = beat.get("notes") as Y.Map<NoteJSON>;
  const note = write(notes.get(key));
  if (note === null && !notes.has(key)) return cursor;
  doc.transact(() => {
    if (note === null) notes.delete(key);
    else notes.set(key, note);
  }, LOCAL);
  return cursor;
}

/** Put a fret on the string of the cursor, keeping what else its note holds; null clears the string. */
export function setFret(doc: Y.Doc, cursor: Cursor, fret: number | null): Cursor {
  return writeNote(doc, cursor, `s${cursor.line}`, (stored) => (fret === null ? null : { ...stored, fret }));
}

/**
 * Put a note at the cursor at the position named by `key` ("s3", "p38", "n61"), replacing the
 * one there; null removes it. The key is not checked against the kind of the part.
 */
export function setNote(doc: Y.Doc, cursor: Cursor, key: string, note: NoteJSON | null): Cursor {
  return writeNote(doc, cursor, key, () => note);
}

/** Whether the cursor stands on a beat without notes: a rest. */
export function isRestAt(doc: Y.Doc, cursor: Cursor): boolean {
  const notes = beatAt(doc, cursor)?.get("notes");
  return notes instanceof Y.Map && notes.size === 0;
}

/**
 * Remove the notes on the line of the cursor, from its beat: on a fretted part, the note on its
 * string. Drums and staves get theirs with the keys that enter their notes (docs/ROADMAP.md, M2
 * and M3): until then nothing is removed from them.
 */
export function deleteNote(doc: Y.Doc, cursor: Cursor): Cursor {
  if (partKindOf(partsOf(doc).get(cursor.partId)) !== "fretted") return cursor;
  return setFret(doc, cursor, null);
}

/**
 * Remove the beat of the cursor. The cursor moves onto the beat that takes its place, or, when
 * it was the last, into the append slot after the new last beat (an empty voice's when none is
 * left).
 */
export function deleteBeat(doc: Y.Doc, cursor: Cursor): Cursor {
  const voice = cursor.at === "on" ? voiceAt(doc, cursor) : undefined;
  const index = voice === undefined ? -1 : indexOfBeat(voice, cursor.beatId);
  if (voice === undefined || index < 0) return cursor;
  doc.transact(() => voice.delete(index, 1), LOCAL);
  if (index < voice.length) return { ...cursor, beatId: voice.get(index).get("id") as string };
  return { ...cursor, beatId: index > 0 ? (voice.get(index - 1).get("id") as string) : null, at: "after" };
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

/** The cursor at the first place of the first voice of a bar of a part: its first beat, or the append slot of an empty voice. */
export function cursorAt(doc: Y.Doc, partId: string, barId: string, line = 1): Cursor {
  const cursor: Cursor = { partId, barId, voice: MAIN_VOICE, beatId: null, at: "after", line };
  const voice = voiceAt(doc, cursor);
  return voice && voice.length > 0 ? { ...cursor, beatId: voice.get(0).get("id") as string, at: "on" } : cursor;
}
