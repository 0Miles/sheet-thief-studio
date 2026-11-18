// Editing commands: each changes the document in one transaction (one undo step) and returns
// where the cursor is afterwards. They never touch the DOM or the renderer.
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { customAlphabet, nanoid } from "nanoid";
import * as Y from "yjs";
import type { z } from "zod";

import {
  BEND_SEMITONES,
  BEND_TYPES,
  type BendType,
  barSchema,
  barsOf,
  beatFieldFits,
  COMMON_TIME,
  contentOf,
  type BeatDuration,
  type Duration,
  durationOf,
  emptyBarContent,
  HARMONICS,
  KIND_DEFAULTS,
  type KeySignature,
  keySigSchema,
  LOCAL,
  MAIN_VOICE,
  MAX_BARS,
  metaOf,
  metaSchema,
  NOTE_VALUES,
  type NoteJSON,
  type NoteValue,
  ordered,
  ownFields,
  parsePlain,
  type PartKind,
  partKindOf,
  partSchemas,
  partsOf,
  readNote,
  readableVoicesOf,
  SCHEMA_VERSION,
  type ScoreJSON,
  SLIDE_INS,
  SLIDE_OUTS,
  type Staff,
  staffCountOf,
  startLine,
  DYNAMICS,
  isVoiceKey,
  MAX_BEAT_TEXT,
  MAX_TITLE,
  stringCountOf,
  contentMapOf,
  type TimeSignature,
  timeSigSchema,
  type Tuplet,
  type VoiceAddress,
  type YBar,
  type YBeat,
  type YPart,
  voiceIn,
  type YVoice,
  voiceKeys,
  withinPartLimits,
} from "./schema";
import { type BeatFields, readBeatFields, readsAsBeat } from "./read";
import { selectedBars, selectedBeats } from "./selection";

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

/** A new id of a bar, a part or a beat (docs/spec/schema.md, section 1). */
export function newId(): string {
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
    const order = ordered(parts);
    const part: YPart = new Y.Map();
    part.set("order", keysAfter(parts, order, order.length - 1, 1)[0]);
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

/** The digits of an ordering key (fractional-indexing's base 62). */
const KEY_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const keySuffix = customAlphabet(KEY_DIGITS, 5);

/**
 * A key above `key` and below `upper`, ending in a random suffix: the keys fractional-indexing
 * makes between two keys are the same for everyone, so two members inserting at the same place
 * at once would make the same key, and no key lies between two equal keys. A suffix of five
 * base-62 digits makes that all but impossible. The fractional part of a key must not end in 0.
 * When `key` is a prefix of `upper` (`a1` below `a1Yx3pQ`, which is common: keys made between
 * suffixed keys often are), `key` and a suffix may reach past `upper`: a key between `key` and
 * `upper` is taken first, until the suffix fits.
 */
function withSuffix(key: string, upper: string | null): string {
  const suffix = keySuffix().replace(/0$/, "1");
  let base = key;
  // Each step at least one digit closer to `upper`, which has finitely many: a few at most.
  while (upper !== null && base + suffix >= upper) base = generateKeyBetween(base, upper);
  return base + suffix;
}

/**
 * Ordering keys for `count` items put right after the one at `index` of `order` (-1: first), the
 * ids of `map` in score order (`ordered`), each with a random suffix (`withSuffix`) so that no
 * two members make the same key (docs/spec/schema.md, section 1). No other item's key is
 * changed. Equal keys sort by id; none lies strictly between them, so after an item whose key the
 * next items share (left by members who inserted before the suffix), the new ones go after all
 * of those.
 */
function keysAfter(map: Y.Map<Y.Map<unknown>>, order: readonly string[], index: number, count: number): string[] {
  const keyAt = (at: number) => orderOf(map.get(order[at] as string));
  const lower = index < 0 ? null : keyAt(index);
  let end = index + 1;
  while (lower !== null && end < order.length && keyAt(end) === lower) end++;
  const upper = end < order.length ? keyAt(end) : null;
  const keys = generateNKeysBetween(lower, upper, count);
  return keys.map((key, i) => withSuffix(key, keys[i + 1] ?? upper));
}

/** The time signature of a bar as reading reads it (docs/spec/schema.md, section 11): 4/4 when it cannot be read. */
function timeSigOf(bar: YBar | undefined): TimeSignature {
  const read = parsePlain(timeSigSchema, bar?.get("timeSig"));
  return read.success ? read.data : COMMON_TIME;
}

/**
 * Insert empty bars for every part; returns their ids in order. They take the time signature
 * given, else the one of the bar they follow, else (first) of the bar they precede, and nothing
 * else of it (docs/spec/commands.md, section 6). Put first, they take the pickup away from the bar
 * that was first. None, and nothing changes, when `after` is gone or the score would have more
 * than `MAX_BARS` bars.
 */
export function insertBars(doc: Y.Doc, { after, count, timeSig }: NewBars): string[] {
  const bars = barsOf(doc);
  const order = ordered(bars);
  const index = after === null ? -1 : order.indexOf(after);
  if ((after !== null && index < 0) || count < 1 || order.length + count > MAX_BARS) return [];
  const ids = Array.from({ length: count }, newId);
  doc.transact(() => {
    const before = index < 0 ? undefined : bars.get(order[index] as string);
    const nextId = order[index + 1];
    const next = nextId === undefined ? undefined : bars.get(nextId);
    const keys = keysAfter(bars, order, index, count);
    const signature = timeSig ?? timeSigOf(before ?? next);
    ids.forEach((id, i) => {
      const bar: YBar = new Y.Map();
      bar.set("order", keys[i]);
      bar.set("timeSig", { ...signature });
      bars.set(id, bar);
      // The member who makes a bar makes its place in every part, in the same transaction.
      for (const part of partsOf(doc).values()) contentOf(part).set(id, emptyBarContent(staffCountOf(part)));
    });
    // Only the first bar can be a pickup (docs/spec/schema.md, section 3).
    if (before === undefined && next?.has("anacrusis")) next.delete("anacrusis");
  }, LOCAL);
  return ids;
}

/** Why a structural command did nothing: the score would have more than `MAX_BARS` bars, or none left. */
export type BarRefusal = "tooManyBars" | "lastBar";

/** Where a bar is inserted: before the cursor's bar (Ctrl+Insert) or after it (Ctrl+Shift+Insert). */
export type BarSide = "before" | "after";

/** The cursor at the first place of its own voice in another bar: its first beat, or the append slot when it is empty. */
function firstPlaceIn(doc: Y.Doc, cursor: Cursor, barId: string): Cursor {
  const voice = voiceIn(doc, { ...cursor, barId });
  const beatId = voice && voice.length > 0 ? (voice.get(0).get("id") as string) : null;
  return { ...cursor, barId, beatId, at: beatId === null ? "after" : "on" };
}

/**
 * Insert one empty bar before or after the cursor's bar, for every part, one command; the cursor
 * moves to its first place, in its own voice and on its own line (docs/spec/commands.md, section 6).
 * `"tooManyBars"` at `MAX_BARS` bars; the cursor as it is when its bar is gone.
 */
export function insertBarAt(doc: Y.Doc, cursor: Cursor, side: BarSide): Cursor | BarRefusal {
  const order = ordered(barsOf(doc));
  const index = order.indexOf(cursor.barId);
  if (index < 0) return cursor;
  if (order.length >= MAX_BARS) return "tooManyBars";
  const [barId] = insertBars(doc, { after: side === "after" ? cursor.barId : (order[index - 1] ?? null), count: 1 });
  return barId === undefined ? cursor : firstPlaceIn(doc, cursor, barId);
}

/**
 * The toolbar's +bar at the end of the score: one bar after the last, the cursor moving there as
 * `insertBarAt` moves it. In a score left with no bars (two members deleted the last two at once,
 * docs/spec/commands.md, section 9) it makes the first one, in 4/4, and the cursor goes to the
 * start of the score: what a member with no cursor (null) left can do to go on. Null when there
 * is still nowhere to put the cursor (no part that can be drawn).
 */
export function appendBar(doc: Y.Doc, cursor: Cursor | null): Cursor | BarRefusal | null {
  const last = ordered(barsOf(doc)).at(-1);
  if (last === undefined) {
    const [barId] = insertBars(doc, { after: null, count: 1 });
    if (barId === undefined) return cursor;
    const kept = cursor && partKindOf(partsOf(doc).get(cursor.partId)) !== undefined ? firstPlaceIn(doc, cursor, barId) : null;
    return kept ?? startOfScore(doc);
  }
  const at = cursor ?? startOfScore(doc);
  return at && insertBarAt(doc, { ...at, barId: last }, "after");
}

/**
 * The bars a structural command works on (docs/spec/commands.md, section 6): a bar range's, or a
 * beat range's one bar; null without a selection, when each command says what it works on.
 */
export function structuralRange(doc: Y.Doc, selection: Selection | null): string[] | null {
  if (selection === null) return null;
  return selection.kind === "beats" ? [selection.barId] : selectedBars(doc, selection);
}

/**
 * Ctrl+Delete: delete the bars of the selection (`structuralRange`), else the cursor's bar, from
 * every part, one command and no question asked: an undo brings them back with what they held
 * then. Beats others send into them meanwhile are lost, the explicit exception to nothing
 * disappearing silently (docs/spec/commands.md, section 9). The cursor moves to the first place of
 * its voice in the bar after them, else in the bar before. `"lastBar"` rather than leave a score
 * with no bars; the cursor as it is when its bars are gone.
 */
export function deleteBarsAt(doc: Y.Doc, cursor: Cursor, selection: Selection | null): Cursor | BarRefusal {
  const bars = barsOf(doc);
  const order = ordered(bars);
  const range = (structuralRange(doc, selection) ?? [cursor.barId]).filter((barId) => order.includes(barId));
  if (range.length === 0) return cursor;
  if (range.length >= order.length) return "lastBar";
  const first = order.indexOf(range[0] as string);
  const last = order.indexOf(range.at(-1) as string);
  const landing = (order[last + 1] ?? order[first - 1]) as string;
  doc.transact(() => {
    for (const barId of range) {
      bars.delete(barId);
      for (const part of partsOf(doc).values()) contentMapOf(part)?.delete(barId);
    }
  }, LOCAL);
  return firstPlaceIn(doc, cursor, landing);
}

/**
 * Give bars a time signature, one command (docs/spec/commands.md, section 6): those of the
 * selection (`structuralRange`); without one, the cursor's bar and the bars after it that have
 * the same time signature, up to the next that differs. Only bars whose time signature changes
 * are written. False, and nothing set, for a time signature out of range (docs/spec/schema.md,
 * section 3), or when the cursor's bar is gone.
 */
export function setTimeSig(doc: Y.Doc, cursor: Cursor, selection: Selection | null, timeSig: TimeSignature): boolean {
  const valid = parsePlain(timeSigSchema, timeSig);
  if (!valid.success) return false;
  const bars = barsOf(doc);
  const order = ordered(bars);
  let range = structuralRange(doc, selection);
  if (range === null) {
    const start = order.indexOf(cursor.barId);
    if (start < 0) return false;
    const was = timeSigOf(bars.get(cursor.barId));
    const end = order.findIndex((barId, index) => index > start && !sameTimeSig(timeSigOf(bars.get(barId)), was));
    range = order.slice(start, end < 0 ? undefined : end);
  }
  if (range.length === 0) return false;
  const { numerator, denominator } = valid.data;
  // A time signature that cannot be read (read as 4/4) is written too.
  const changed = range.filter((barId) => !storedAs(timeSigSchema, bars.get(barId)?.get("timeSig"), valid.data));
  if (changed.length > 0) doc.transact(() => changed.forEach((barId) => bars.get(barId)?.set("timeSig", { numerator, denominator })), LOCAL);
  return true;
}

function sameTimeSig(a: TimeSignature, b: TimeSignature): boolean {
  return a.numerator === b.numerator && a.denominator === b.denominator;
}

const tempoSchema = barSchema.shape.tempo.unwrap();

/**
 * Change the tempo from the cursor's bar on, written on that bar only, one command; null takes
 * that change away (docs/spec/commands.md, section 6). False, and nothing set, for a tempo out of
 * 20 to 400, or when the cursor's bar is gone. The same tempo writes nothing.
 */
export function setTempo(doc: Y.Doc, cursor: Cursor, tempo: number | null): boolean {
  const bar = barsOf(doc).get(cursor.barId);
  if (bar === undefined || (tempo !== null && !tempoSchema.safeParse(tempo).success)) return false;
  writeField(bar, "tempo", tempoSchema, tempo ?? undefined);
  return true;
}

/** Whether a stored value reads as `value` (docs/spec/schema.md, section 11): one that cannot be read never does. */
function storedAs<Schema extends z.ZodType>(schema: Schema, stored: unknown, value: z.output<Schema>): boolean {
  const read = parsePlain(schema, stored);
  return read.success && JSON.stringify(read.data) === JSON.stringify(value);
}

/** A copy of a value of the document, down to the plain objects in a list (the staves of a part). */
function copyOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyOf);
  return typeof value === "object" && value !== null ? { ...value } : value;
}

/**
 * Write a field of a bar, a part or the meta, or take it away (undefined), one command: none when
 * it already reads so. The value is copied, so that no two of them share it.
 */
function writeField<Schema extends z.ZodType>(map: Y.Map<unknown>, name: string, schema: Schema, value: z.output<Schema> | undefined): void {
  if (value === undefined ? !map.has(name) : storedAs(schema, map.get(name), value)) return;
  (map.doc as Y.Doc).transact(() => {
    if (value === undefined) map.delete(name);
    // Every value of a bar or a part is a number, a string, a list or an object of plain fields, or a list of such objects.
    else map.set(name, copyOf(value));
  }, LOCAL);
}

/**
 * Change the key from the cursor's bar on, written on that bar only, one command; null takes that
 * change away (docs/spec/commands.md, section 6). False, and nothing set, for a key out of range
 * (docs/spec/schema.md, section 3), or when the cursor's bar is gone. The same key writes nothing.
 */
export function setKeySig(doc: Y.Doc, cursor: Cursor, keySig: KeySignature | null): boolean {
  const bar = barsOf(doc).get(cursor.barId);
  const valid = keySig === null ? null : parsePlain(keySigSchema, keySig);
  if (bar === undefined || (valid !== null && !valid.success)) return false;
  writeField(bar, "keySig", keySigSchema, valid?.data);
  return true;
}

const sectionSchema = barSchema.shape.section.unwrap();

/**
 * Name the section that starts at the cursor's bar, one command; null takes the name away
 * (docs/spec/commands.md, section 6). False, and nothing set, for a name not of 1 to 64
 * characters, or when the cursor's bar is gone. The same name writes nothing.
 */
export function setSection(doc: Y.Doc, cursor: Cursor, section: string | null): boolean {
  const bar = barsOf(doc).get(cursor.barId);
  if (bar === undefined || (section !== null && !sectionSchema.safeParse(section).success)) return false;
  writeField(bar, "section", sectionSchema, section ?? undefined);
  return true;
}

/** What `setRepeat` does: repeat its bars `times` times in all, or clear the start or the end of a repeat. */
export type RepeatChange = { times: number } | { clear: "start" | "end" };

const repeatEndSchema = barSchema.shape.repeatEnd.unwrap();
const repeatStartSchema = barSchema.shape.repeatStart.unwrap();

/**
 * The bars a structural command that writes on bars where they are works on: those of the
 * selection (`structuralRange`) still in the score, else the cursor's bar; none when they are gone.
 */
function barsWorkedOn(doc: Y.Doc, cursor: Cursor, selection: Selection | null): string[] {
  const bars = barsOf(doc);
  return (structuralRange(doc, selection) ?? [cursor.barId]).filter((barId) => bars.has(barId));
}

/**
 * A repeat, one command (docs/spec/commands.md, section 6): its start on the first bar of the
 * selection (`structuralRange`), its end, how many times it is played in all (2 to 32), on the
 * last; without a selection, both on the cursor's bar. Either can be cleared alone, from the same
 * bar it is written on. Nothing else is changed: a repeat begun or ended elsewhere stays. False,
 * and nothing set, for a count out of range, or when the bars are gone.
 */
export function setRepeat(doc: Y.Doc, cursor: Cursor, selection: Selection | null, change: RepeatChange): boolean {
  const range = barsWorkedOn(doc, cursor, selection);
  const bars = barsOf(doc);
  const first = bars.get(range[0] as string);
  const last = bars.get(range.at(-1) as string);
  if (first === undefined || last === undefined) return false;
  if ("clear" in change) {
    if (change.clear === "start") writeField(first, "repeatStart", repeatStartSchema, undefined);
    else writeField(last, "repeatEnd", repeatEndSchema, undefined);
    return true;
  }
  if (!repeatEndSchema.safeParse(change.times).success) return false;
  // One transaction: the two writes, when both are needed, are one undo step.
  doc.transact(() => {
    writeField(first, "repeatStart", repeatStartSchema, true);
    writeField(last, "repeatEnd", repeatEndSchema, change.times);
  }, LOCAL);
  return true;
}

const voltasSchema = barSchema.shape.voltas.unwrap();

/**
 * The passes of a repeat the bars of the selection (`structuralRange`), else the cursor's bar,
 * are played on, written on every one of them, one command; none (an empty list) clears them
 * (docs/spec/commands.md, section 6). False, and nothing set, unless the passes are 1 to 8 in
 * increasing order, or when the bars are gone. Bars that already read so are not written.
 */
export function setVoltas(doc: Y.Doc, cursor: Cursor, selection: Selection | null, passes: readonly number[]): boolean {
  const range = barsWorkedOn(doc, cursor, selection);
  const valid = passes.length === 0 ? null : parsePlain(voltasSchema, [...passes]);
  if (range.length === 0 || (valid !== null && !valid.success)) return false;
  const bars = barsOf(doc);
  doc.transact(() => {
    for (const barId of range) writeField(bars.get(barId) as YBar, "voltas", voltasSchema, valid?.data);
  }, LOCAL);
  return true;
}

/**
 * Make the first bar a pickup bar, or a full one again, one command (docs/spec/commands.md,
 * section 6). False, and nothing changed, on any bar but the first: only the first bar can be a
 * pickup (docs/spec/schema.md, section 3). A pickup that cannot be read is no pickup: it is set.
 */
export function toggleAnacrusis(doc: Y.Doc, cursor: Cursor): boolean {
  const bars = barsOf(doc);
  const [first] = ordered(bars);
  const bar = first === cursor.barId ? bars.get(first) : undefined;
  if (bar === undefined) return false;
  const schema = barSchema.shape.anacrusis.unwrap();
  writeField(bar, "anacrusis", schema, storedAs(schema, bar.get("anacrusis"), true) ? undefined : true);
  return true;
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
  return voiceIn(doc, cursor);
}

function indexOfBeat(voice: YVoice, beatId: string | null): number {
  if (beatId === null) return -1;
  for (let i = 0; i < voice.length; i++) if (voice.get(i).get("id") === beatId) return i;
  return -1;
}

/** Where the beat the cursor stands on is: its voice and its index there; none in the append slot or when the beat is gone. */
function beatIndexAt(doc: Y.Doc, cursor: Cursor): { voice: YVoice; index: number } | undefined {
  if (cursor.at !== "on") return undefined;
  const voice = voiceAt(doc, cursor);
  const index = voice === undefined ? -1 : indexOfBeat(voice, cursor.beatId);
  return voice === undefined || index < 0 ? undefined : { voice, index };
}

/** The beat the cursor stands on; none in the append slot. */
function beatAt(doc: Y.Doc, cursor: Cursor): YBeat | undefined {
  const found = beatIndexAt(doc, cursor);
  return found?.voice.get(found.index);
}

/** What a beat gets when there is no beat to take its duration from. */
const QUARTER: BeatDuration = { value: 4, dots: 0 };

/** Where a beat made at the cursor goes: its voice, its index there, and how long it lasts unless told otherwise. */
interface BeatPlace {
  voice: YVoice;
  index: number;
  duration: BeatDuration;
}

/** The duration a beat made at a place takes from `beat`: as long as it, else a quarter. */
function durationFrom(beat: YBeat | undefined): BeatDuration {
  return (beat && durationOf(beat)) ?? QUARTER;
}

/**
 * Where a beat made at the cursor goes: on a beat, just before it, as long as it; in the append
 * slot, just after the anchor, as long as the anchor (first and a quarter in an empty voice; when
 * the anchor is gone, after the last beat and as long as it, where the cursor settles).
 * Undefined when the cursor's beat or voice is gone.
 */
function placeFor(doc: Y.Doc, cursor: Cursor): BeatPlace | undefined {
  if (cursor.at === "on") {
    const found = beatIndexAt(doc, cursor);
    return found && { ...found, duration: durationFrom(found.voice.get(found.index)) };
  }
  const voice = voiceAt(doc, cursor);
  if (voice === undefined) return undefined;
  if (cursor.beatId === null) return { voice, index: 0, duration: QUARTER };
  const found = indexOfBeat(voice, cursor.beatId);
  const anchor = found < 0 ? voice.length - 1 : found;
  return { voice, index: anchor + 1, duration: durationFrom(anchor < 0 ? undefined : voice.get(anchor)) };
}

/**
 * Make a beat at the cursor, in one transaction (one undo step), and move the cursor onto it: a
 * rest of `duration`, then `fill` puts its notes on it.
 */
function makeBeat(doc: Y.Doc, cursor: Cursor, place: BeatPlace, { value, dots, tuplet }: BeatDuration, fill?: (notes: Y.Map<NoteJSON>) => void): Cursor {
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
export function insertBeat(doc: Y.Doc, cursor: Cursor, duration?: Duration): Cursor {
  const place = placeFor(doc, cursor);
  return place === undefined ? cursor : makeBeat(doc, cursor, place, duration === undefined ? place.duration : { dots: 0, ...duration });
}

/**
 * A note as the commands that rewrite it see it: its own fields (`ownFields`), so that every
 * member decides and writes alike (#103); none for nothing stored.
 */
function asStored(value: unknown): NoteJSON | undefined {
  return value === undefined ? undefined : (ownFields(value) as NoteJSON);
}

/**
 * Write a note at the cursor, one command: on its beat, or in the append slot on a new beat made
 * there (as `insertBeat` makes it), the cursor then on that beat. `write` gets the note stored
 * at `key` (`asStored`) and returns the new one, or null to remove it; removing makes no beat.
 */
function writeNote(doc: Y.Doc, cursor: Cursor, key: string, write: (stored: NoteJSON | undefined) => NoteJSON | null): Cursor {
  if (cursor.at === "after") {
    const note = write(undefined);
    const place = placeFor(doc, cursor);
    if (note === null || place === undefined) return cursor;
    return makeBeat(doc, cursor, place, place.duration, (notes) => notes.set(key, note));
  }
  const notes = notesOf(beatAt(doc, cursor));
  if (notes === undefined) return cursor;
  const stored = asStored(notes.get(key));
  const note = write(stored);
  // Given back as stored, or nothing to remove: nothing is written.
  if (note === stored || (note === null && stored === undefined)) return cursor;
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

/**
 * The techniques a note has or has not (docs/spec/commands.md, 5.4): a key turns each on and off
 * (`techniqueToggle`). Tie is on or off too but is not one of them: it also takes the fret of the
 * note before, so it is a toggle of its own.
 */
export const ON_OFF_TECHNIQUES = ["dead", "ghost", "accent", "staccato", "vibrato", "palmMute", "letRing", "tap", "legato"] as const;
export type OnOffTechnique = (typeof ON_OFF_TECHNIQUES)[number];

/**
 * Where a note a toggle turns stands: the kind of its part, its key, and the note with the same
 * key on the beat before in its voice (the last beat of the bar before, for the first beat of a
 * bar), when one can be read.
 */
export interface NotePlace {
  kind: PartKind;
  key: string;
  before: NoteJSON | undefined;
}

/**
 * A technique a key changes on notes (docs/spec/commands.md, 5.4), at the cursor or over a
 * selection. What the notes are to become is decided once, from the notes seen (the one on the
 * cursor's line, none when the line is empty; every note of the selection), then each note is
 * turned to it: one state for all, so that a selection whose notes differ ends in one state.
 */
export interface NoteToggle<D> {
  decide(seen: readonly NoteJSON[]): D;
  /**
   * The note at `place` once turned to `decided`, from the note as stored, its own fields
   * (`ownFields`: fields this version does not know are kept, one named __proto__ is not; undefined
   * where there is none): null for no note there, removing one stored; `stored` itself to leave it
   * as it is, which writes nothing.
   */
  turn(stored: NoteJSON | undefined, decided: D, place: NotePlace): NoteJSON | null;
}

/** An on/off technique but dead (`deadToggle`): on, or off when every note seen has it, on the notes there are; it makes none. */
export function onOffToggle(technique: Exclude<OnOffTechnique, "dead">): NoteToggle<boolean> {
  return plainToggle(technique);
}

function plainToggle(technique: OnOffTechnique | "tie"): NoteToggle<boolean> {
  return {
    decide: (seen) => !seen.every((note) => note[technique] === true),
    turn(stored, on) {
      if (stored === undefined || (stored[technique] === true) === on) return stored ?? null;
      return withField(stored, technique, on ? true : undefined);
    },
  };
}

/** The note as stored with `field` set to `value`, or without it for undefined; every other field kept. */
function withField<F extends keyof NoteJSON>(stored: NoteJSON, field: F, value: NoteJSON[F]): NoteJSON {
  const note = { ...stored };
  if (value === undefined) delete note[field];
  else note[field] = value;
  return note;
}

const plainDead = plainToggle("dead");

/**
 * Dead, which a fretted note may hold instead of a fret (docs/spec/schema.md, section 8): on an
 * empty line it makes a dead note without a fret, and turned off on such a note it takes the note
 * away, which would otherwise hold neither.
 */
export const deadToggle: NoteToggle<boolean> = {
  decide: (seen) => seen.length === 0 || plainDead.decide(seen),
  turn(stored, on, place) {
    if (stored === undefined) return on ? { dead: true } : null;
    return !on && stored.dead === true && stored.fret === undefined ? null : plainDead.turn(stored, on, place);
  },
};

const plainTie = plainToggle("tie");

/**
 * Tie (docs/spec/commands.md, 5.4): on, unless every note seen has it already; on an empty line
 * it is on too, to make the note there. Adding it takes the fret of the note before on the same
 * string, the command's own doing, not a repair; with no fret before, the note keeps its own and
 * is a dangling tie (docs/spec/flags.md). On an empty line it makes the note before's fret there,
 * or on a staff (a pitched part's key is its pitch) the note before's pitch as it is spelled; with
 * no such note before, nothing. Off takes the tie away and keeps the fret.
 */
export const tieToggle: NoteToggle<boolean> = {
  decide: (seen) => seen.length === 0 || plainTie.decide(seen),
  turn(stored, on, place) {
    const { kind, before } = place;
    // A note tied already, to the fret before or with none to take, is left as it is.
    if (on && before?.fret !== undefined) return stored?.tie === true && stored.fret === before.fret ? stored : { ...stored, fret: before.fret, tie: true };
    if (!on || stored !== undefined) return plainTie.turn(stored, on, place);
    if (before === undefined || kind !== "pitched") return null;
    return before.spell === undefined ? { tie: true } : { spell: before.spell, tie: true };
  },
};

/**
 * A technique of several kinds a key steps through, back to none (docs/spec/commands.md, 5.4):
 * every note to the kind after the one of the first note seen, as the beat markings do
 * (`markingCycle`), on the notes there are; it makes none.
 */
function noteCycle<F extends "slideOut" | "slideIn" | "harmonic">(field: F, kinds: readonly NonNullable<NoteJSON[F]>[]): NoteToggle<NoteJSON[F]> {
  return {
    decide: (seen) => nextOf(kinds, seen[0]?.[field]),
    turn(stored, kind) {
      if (stored === undefined || stored[field] === kind) return stored ?? null;
      return withField(stored, field, kind);
    },
  };
}

/** Shift+S: a slide out of the note, legato, shift, out up, out down, then none. Legato and shift go on to the next note on the string. */
export const slideOutCycle: NoteToggle<NoteJSON["slideOut"]> = noteCycle("slideOut", SLIDE_OUTS);

/** Shift+E: a slide into the note, from below, from above, then none. */
export const slideInCycle: NoteToggle<NoteJSON["slideIn"]> = noteCycle("slideIn", SLIDE_INS);

/** Shift+N: a harmonic of the note, natural, pinch, artificial, then none. */
export const harmonicCycle: NoteToggle<NoteJSON["harmonic"]> = noteCycle("harmonic", HARMONICS);

/**
 * Shift+B: a bend of the note, bend, bend and release, pre-bend, pre-bend and release, then none,
 * stepped as the slides are (`noteCycle`). A new bend goes up 2 semitones; a bend that changes
 * shape keeps its own.
 */
export const bendCycle: NoteToggle<BendType | undefined> = {
  decide: (seen) => nextOf(BEND_TYPES, seen[0]?.bend?.type),
  turn(stored, type) {
    if (stored === undefined || stored.bend?.type === type) return stored ?? null;
    return withField(stored, "bend", type && { type, semitones: stored.bend?.semitones ?? BEND_SEMITONES.initial });
  },
};

/**
 * Shift+↑ and Shift+↓ on a fretted part: each note's bend a semitone more or less, held to 1 to 4
 * (docs/spec/commands.md, 5.4); a note with no bend is left as it is.
 */
export function bendStep(step: 1 | -1): NoteToggle<void> {
  return {
    decide: () => undefined,
    turn(stored) {
      if (stored?.bend === undefined) return stored ?? null;
      const { bend } = stored;
      const semitones = Math.min(BEND_SEMITONES.max, Math.max(BEND_SEMITONES.min, bend.semitones + step));
      return semitones === bend.semitones ? stored : withField(stored, "bend", { ...bend, semitones });
    },
  };
}

/** The toggle of each technique a key turns on and off. */
export function techniqueToggle(technique: OnOffTechnique): NoteToggle<boolean> {
  return technique === "dead" ? deadToggle : onOffToggle(technique);
}

/**
 * The key of the note on the cursor's line, the one a technique key changes at the cursor: its
 * string on a fretted part. None on drums and staves until their keys name the notes drawn on a
 * line (docs/ROADMAP.md, M2 and M3), as with `deleteNote`.
 */
export function noteKeyAt(doc: Y.Doc, cursor: Cursor): string | null {
  return partKindOf(partsOf(doc).get(cursor.partId)) === "fretted" ? `s${cursor.line}` : null;
}

/** How the beats and notes of a part are read: by its kind and its strings. */
interface PartReader {
  kind: PartKind;
  /** The note a value stored at `key` reads as (`readNote`); none for nothing stored. */
  note(key: string, stored: unknown): NoteJSON | undefined;
}

/** How a part is read; none when its kind cannot be read. */
function readerOf(doc: Y.Doc, partId: string): PartReader | undefined {
  const part = partsOf(doc).get(partId);
  const kind = partKindOf(part);
  if (part === undefined || kind === undefined) return undefined;
  const strings = stringCountOf(part);
  return { kind, note: (key, stored) => (stored === undefined ? undefined : readNote(kind, strings, key, stored)) };
}

/** The notes of the last beat before `end` in a voice that reading keeps (`readsAsBeat`). */
function lastReadNotes(reader: PartReader, voice: YVoice, end: number): Y.Map<NoteJSON> | undefined {
  for (let index = end - 1; index >= 0; index--) {
    const beat = voice.get(index);
    if (readsAsBeat(reader.kind, beat)) return notesOf(beat);
  }
  return undefined;
}

/**
 * The notes of the beat before `index` in a voice, as the members see it: the last beat before it
 * that reading keeps, else the last such beat of the same voice in the bar before.
 */
function notesBefore(doc: Y.Doc, reader: PartReader, address: VoiceAddress, voice: YVoice, index: number): Y.Map<NoteJSON> | undefined {
  const own = lastReadNotes(reader, voice, index);
  if (own !== undefined) return own;
  const bars = ordered(barsOf(doc));
  const previous = bars[bars.indexOf(address.barId) - 1];
  const before = previous === undefined ? undefined : voiceIn(doc, { ...address, barId: previous });
  return before && lastReadNotes(reader, before, before.length);
}

/**
 * Change the note at `key` of the cursor's beat with a technique, one command: the toggle decides
 * from that note, or from none when the line is empty. In the append slot a note it makes goes on
 * a new beat (as a digit does), the cursor then on it. A beat or a note reading leaves out is not
 * seen and is left alone (docs/spec/schema.md, section 11).
 */
export function toggleAt<D>(doc: Y.Doc, cursor: Cursor, key: string, toggle: NoteToggle<D>): Cursor {
  const reader = readerOf(doc, cursor.partId);
  const place = placeFor(doc, cursor);
  if (reader === undefined || place === undefined) return cursor;
  const beat = cursor.at === "on" ? place.voice.get(place.index) : undefined;
  if (beat !== undefined && !readsAsBeat(reader.kind, beat)) return cursor;
  const stored = notesOf(beat)?.get(key);
  const seen = reader.note(key, stored);
  if (stored !== undefined && seen === undefined) return cursor;
  // On a beat, the beat before it; in the append slot, the anchor the new beat goes after.
  const before = reader.note(key, notesBefore(doc, reader, cursor, place.voice, place.index)?.get(key));
  const decided = toggle.decide(seen === undefined ? [] : [seen]);
  return writeNote(doc, cursor, key, (note) => toggle.turn(note, decided, { kind: reader.kind, key, before }));
}

/** The beats of one voice a selection holds, first to last, and where they are: to find the beat before each. */
interface SelectedRun {
  barId: string;
  voiceKey: string;
  voice: YVoice;
  first: number;
  last: number;
}

/**
 * What a selection holds in the part selected: its beats in its voice, or every voice of the part
 * in the bars of a bar range. Only the voices reading reads, in their order (docs/spec/schema.md,
 * section 11): not a voice of a staff the part does not have, and not one stored as something else than beats.
 */
function runsOf(doc: Y.Doc, selection: Selection): SelectedRun[] {
  const part = partsOf(doc).get(selection.partId);
  if (part === undefined) return [];
  if (selection.kind === "beats") {
    const found = isVoiceKey(selection.voice, staffCountOf(part)) ? selectedBeats(doc, selection) : undefined;
    return found ? [{ barId: selection.barId, voiceKey: selection.voice, ...found }] : [];
  }
  return selectedBars(doc, selection).flatMap((barId) => readableVoicesOf(part, barId).map(([voiceKey, voice]) => ({ barId, voiceKey, voice, first: 0, last: voice.length - 1 })));
}

/** A beat of a selection that reading keeps, its notes, and where it is. */
interface SelectedBeat {
  address: VoiceAddress;
  voice: YVoice;
  index: number;
  beat: YBeat;
  map: Y.Map<NoteJSON>;
}

/**
 * The beats of a selection, in the part selected, runs in score order and beats in the order of
 * their voice; those reading leaves out are not among them.
 */
function selectedBeatsOf(doc: Y.Doc, reader: PartReader, selection: Selection): SelectedBeat[] {
  return runsOf(doc, selection).flatMap(({ barId, voiceKey, voice, first, last }) =>
    Array.from({ length: last - first + 1 }, (_, offset) => first + offset).flatMap((index) => {
      const beat = voice.get(index);
      // A beat reading keeps has its notes in a map.
      const map = readsAsBeat(reader.kind, beat) ? notesOf(beat) : undefined;
      return map ? [{ address: { partId: selection.partId, barId, voice: voiceKey }, voice, index, beat, map }] : [];
    }),
  );
}

/**
 * Change every note of a selection, in the part selected, with a technique (docs/spec/commands.md,
 * 5.4), one command: the toggle decides once from all of them, then turns each, in the order of
 * its voice, so that each is told the note before as it has just become. Only what the members
 * see counts: beats and notes reading leaves out are left alone (docs/spec/schema.md, section 11).
 * Makes no notes where there are none; changes nothing when the selection holds no notes. The
 * cursor stays where it is.
 */
export function toggleOnSelection<D>(doc: Y.Doc, selection: Selection, cursor: Cursor, toggle: NoteToggle<D>): Cursor {
  const reader = readerOf(doc, selection.partId);
  if (reader === undefined) return cursor;
  const beats = selectedBeatsOf(doc, reader, selection).map(({ address, voice, index, map }) => {
    const notes = [...map.entries()].flatMap(([key, value]) => {
      const seen = reader.note(key, value);
      return seen ? [{ key, stored: asStored(value), seen }] : [];
    });
    return { address, voice, index, map, notes };
  });
  const seen = beats.flatMap(({ notes }) => notes.map((note) => note.seen));
  if (seen.length === 0) return cursor;
  const decided = toggle.decide(seen);
  // What each note of the selection has become, by the notes of its beat: runs come in score order, beats in voice order.
  const turned = new Map<Y.Map<NoteJSON>, Map<string, NoteJSON | null>>();
  const changes: { map: Y.Map<NoteJSON>; key: string; next: NoteJSON | null }[] = [];
  for (const { address, voice, index, map, notes } of beats) {
    const before = notesBefore(doc, reader, address, voice, index);
    const earlier = before && turned.get(before);
    const results = new Map<string, NoteJSON | null>();
    turned.set(map, results);
    for (const { key, stored } of notes) {
      const previous = earlier?.has(key) ? (earlier.get(key) ?? undefined) : reader.note(key, before?.get(key));
      const next = toggle.turn(stored, decided, { kind: reader.kind, key, before: previous });
      results.set(key, next);
      if (next !== stored) changes.push({ map, key, next });
    }
  }
  // Only the notes that change are written: the change and its undo step hold just those.
  if (changes.length > 0) {
    doc.transact(() => {
      for (const { map, key, next } of changes) {
        if (next === null) map.delete(key);
        else map.set(key, next);
      }
    }, LOCAL);
  }
  return cursor;
}

/** The notes of a beat, as the commands change them; none when they cannot be read. */
function notesOf(beat: YBeat | undefined): Y.Map<NoteJSON> | undefined {
  const notes = beat?.get("notes");
  return notes instanceof Y.Map ? (notes as Y.Map<NoteJSON>) : undefined;
}

/** A beat without notes: a rest. */
function isRest(beat: YBeat | undefined): boolean {
  return notesOf(beat)?.size === 0;
}

/** Whether the cursor stands on a beat without notes: a rest. */
export function isRestAt(doc: Y.Doc, cursor: Cursor): boolean {
  return isRest(beatAt(doc, cursor));
}

/**
 * The cursor once the beats from `index` on were removed from its voice: on the beat that takes
 * their place, or, when they were the last, in the append slot after the new last beat (an
 * empty voice's when none is left).
 */
function afterRemoval(cursor: Cursor, voice: YVoice, index: number): Cursor {
  if (index < voice.length) return { ...cursor, beatId: voice.get(index).get("id") as string, at: "on" };
  return { ...cursor, beatId: index > 0 ? (voice.get(index - 1).get("id") as string) : null, at: "after" };
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
  const found = beatIndexAt(doc, cursor);
  if (found === undefined) return cursor;
  const { voice, index } = found;
  doc.transact(() => voice.delete(index, 1), LOCAL);
  return afterRemoval(cursor, voice, index);
}

/**
 * Delete on a selection (docs/spec/commands.md, 5.6), one command, in the part selected only. A
 * beat range: its beats become rests, keeping their durations and everything else they hold;
 * when all of them are rests already, they are removed, and the cursor moves onto the beat that
 * takes their place, or into the append slot after the new last beat. A bar range: every voice
 * of the part in those bars is emptied, a bar's rest; the cursor in one of them moves into the
 * append slot of its empty voice. Changes nothing when what the selection names is gone.
 */
export function deleteSelection(doc: Y.Doc, selection: Selection, cursor: Cursor): Cursor {
  if (selection.kind === "bars") {
    const voices = runsOf(doc, selection).map((run) => run.voice);
    if (!voices.some((voice) => voice.length > 0)) return cursor;
    // Each voice is emptied where it is, not replaced: beats someone types there meanwhile are kept (docs/spec/commands.md, 5.7).
    doc.transact(() => voices.forEach((voice) => voice.delete(0, voice.length)), LOCAL);
    const mine = voiceAt(doc, cursor);
    return mine !== undefined && voices.includes(mine) ? { ...cursor, beatId: null, at: "after" } : cursor;
  }
  const found = selectedBeats(doc, selection);
  if (found === undefined) return cursor;
  const { voice, first, last } = found;
  const beats = voice.slice(first, last + 1);
  if (beats.every(isRest)) {
    doc.transact(() => voice.delete(first, beats.length), LOCAL);
    return afterRemoval(cursor, voice, first);
  }
  const notes = beats.map(notesOf).filter((each): each is Y.Map<NoteJSON> => each !== undefined && each.size > 0);
  if (notes.length > 0) doc.transact(() => notes.forEach((each) => each.clear()), LOCAL);
  return cursor;
}

/** Give the beat of the cursor a note value and dots; its tuplet stays. */
export function setDuration(doc: Y.Doc, cursor: Cursor, { value, dots = 0 }: Omit<Duration, "tuplet">): Cursor {
  const beat = beatAt(doc, cursor);
  if (beat === undefined) return cursor;
  doc.transact(() => {
    beat.set("value", value);
    beat.set("dots", dots);
  }, LOCAL);
  return cursor;
}

/**
 * The markings of a beat a key sets, its duration and notes apart (docs/spec/commands.md, 5.4 and
 * 5.5): stored in the score, unlike a flag (CONTEXT.md).
 */
export type BeatMarkings = Pick<BeatFields, "stroke" | "slap" | "pop" | "dynamic" | "text">;

/** A beat as a `BeatChange` sees it: how long it lasts, whether it is a rest, and its markings as read. */
export interface SeenBeat {
  duration: BeatDuration;
  rest: boolean;
  markings: BeatMarkings;
}

/**
 * What a `BeatChange` writes on a beat: a note value, dots, a tuplet (null takes it away), its
 * notes taken away, or markings (`set`: a value puts one there, null takes it away).
 */
export interface BeatWrite {
  value?: NoteValue;
  dots?: 0 | 1 | 2;
  tuplet?: Tuplet | null;
  clear?: true;
  set?: { [F in keyof BeatMarkings]?: NonNullable<BeatMarkings[F]> | null };
}

/**
 * A change a key makes to whole beats (docs/spec/commands.md, 5.3, 5.4 and 5.6), on the cursor's
 * beat or on every beat of a selection. As with `NoteToggle`, what the beats are to become is
 * decided once, from every beat seen, then each beat is changed to it.
 */
export interface BeatChange<D> {
  decide(seen: readonly SeenBeat[]): D;
  /**
   * What to write on a beat to make it `decided`; null when there is nothing to write (unlike
   * `NoteToggle.turn`, whose null removes a note: a beat is never removed here).
   */
  turn(beat: SeenBeat, decided: D): BeatWrite | null;
}

/** `+` (`step` 1) and `-` (-1): each beat one note value shorter or longer, keeping its dots; a beat at either end of the values stays. */
export function durationStep(step: 1 | -1): BeatChange<void> {
  return {
    decide: () => undefined,
    turn({ duration }) {
      const value = NOTE_VALUES[NOTE_VALUES.indexOf(duration.value) + step];
      return value === undefined ? null : { value };
    },
  };
}

/** `.`: every beat to the dots after those of the first beat seen: none, one, two, none. */
export const dotCycle: BeatChange<0 | 1 | 2> = {
  decide: (seen) => (((seen[0]?.duration.dots ?? 0) + 1) % 3) as 0 | 1 | 2,
  turn: ({ duration }, dots) => (duration.dots === dots ? null : { dots }),
};

const TRIPLET: Tuplet = { actual: 3, normal: 2 };

/**
 * `Shift+T`: every tuplet comes off when every beat seen has one (on one beat: any tuplet);
 * otherwise every beat becomes a triplet, a beat with another tuplet among them.
 */
export const tripletToggle: BeatChange<boolean> = {
  decide: (seen) => seen.some((beat) => beat.duration.tuplet === undefined),
  turn({ duration: { tuplet } }, on) {
    if (!on) return tuplet === undefined ? null : { tuplet: null };
    return tuplet?.actual === TRIPLET.actual && tuplet.normal === TRIPLET.normal ? null : { tuplet: { ...TRIPLET } };
  },
};

/** `Shift+R`: every beat a rest, its notes taken away and everything else it holds kept. */
export const clearNotes: BeatChange<void> = {
  decide: () => undefined,
  turn: ({ rest }) => (rest ? null : { clear: true }),
};

/** How a `BeatChange` sees a beat; none when reading leaves it out. */
function seenBeat(reader: PartReader, beat: YBeat): SeenBeat | undefined {
  const fields = readBeatFields(reader.kind, beat);
  if (fields === undefined) return undefined;
  const { value, dots, tuplet } = fields;
  return { duration: { value, dots, tuplet }, rest: isRest(beat), markings: fields };
}

/** Whether a beat of a part of `kind` may hold what a write sets: stroke, slap and pop are a fretted part's only. */
function fits(write: BeatWrite, kind: PartKind): boolean {
  return Object.keys(write.set ?? {}).every((field) => beatFieldFits(field, kind));
}

/** Change beats as decided, in one transaction; none when nothing changes, or when it sets a field the kind of the part has not. */
function writeBeats<D>(doc: Y.Doc, beats: YBeat[], reader: PartReader, change: BeatChange<D>): void {
  const seen = beats.flatMap((beat) => {
    const read = seenBeat(reader, beat);
    return read ? [{ beat, read }] : [];
  });
  if (seen.length === 0) return;
  const decided = change.decide(seen.map(({ read }) => read));
  const writes = seen.flatMap(({ beat, read }) => {
    const write = change.turn(read, decided);
    return write === null ? [] : [{ beat, write }];
  });
  if (writes.length === 0 || !writes.every(({ write }) => fits(write, reader.kind))) return;
  doc.transact(() => {
    for (const { beat, write } of writes) {
      if (write.value !== undefined) beat.set("value", write.value);
      if (write.dots !== undefined) beat.set("dots", write.dots);
      if (write.tuplet === null) beat.delete("tuplet");
      else if (write.tuplet !== undefined) beat.set("tuplet", write.tuplet);
      if (write.clear) notesOf(beat)?.clear();
      for (const [field, value] of Object.entries(write.set ?? {})) {
        if (value === null) beat.delete(field);
        else beat.set(field, value);
      }
    }
  }, LOCAL);
}

/** Change the beat of the cursor, one command; nothing in the append slot, or on a beat reading leaves out. The cursor stays. */
export function changeBeatAt<D>(doc: Y.Doc, cursor: Cursor, change: BeatChange<D>): Cursor {
  const reader = readerOf(doc, cursor.partId);
  const beat = beatAt(doc, cursor);
  if (reader !== undefined && beat !== undefined) writeBeats(doc, [beat], reader, change);
  return cursor;
}

/**
 * Change every beat of a selection, in the part selected (docs/spec/commands.md, 5.3 and 5.6),
 * one command, decided once from all of them. Beats reading leaves out are neither seen nor
 * changed. The cursor stays.
 */
export function changeBeatsOnSelection<D>(doc: Y.Doc, selection: Selection, cursor: Cursor, change: BeatChange<D>): Cursor {
  const reader = readerOf(doc, selection.partId);
  if (reader !== undefined) writeBeats(doc, selectedBeatsOf(doc, reader, selection).map(({ beat }) => beat), reader, change);
  return cursor;
}

/** The value after `current` in `values`, the first after none, and none after the last. */
function nextOf<T>(values: readonly T[], current: T | undefined): T | undefined {
  return current === undefined ? values[0] : values[values.indexOf(current) + 1];
}

/**
 * A beat marking that steps through `values` and back to none: every beat to the value after the
 * one of the first beat seen, as `.` does with dots.
 */
function markingCycle<F extends "stroke" | "dynamic">(field: F, values: readonly NonNullable<BeatMarkings[F]>[]): BeatChange<NonNullable<BeatMarkings[F]> | null> {
  return {
    decide: (seen) => nextOf(values, seen[0]?.markings[field] ?? undefined) ?? null,
    turn: ({ markings }, next) => ((markings[field] ?? null) === next ? null : { set: { [field]: next } }),
  };
}

/** Shift+U: the beat strummed down, then up, then not at all. Fretted parts only. */
export const strokeCycle: BeatChange<"down" | "up" | null> = markingCycle("stroke", ["down", "up"]);

/** Shift+F: the beat's dynamic, pp to ff, then none. */
export const dynamicCycle: BeatChange<NonNullable<BeatMarkings["dynamic"]> | null> = markingCycle("dynamic", DYNAMICS);

/** Shift+J: the beat slapped, then popped, then neither; never both (docs/spec/schema.md, section 6). Fretted parts only. */
export const slapPopCycle: BeatChange<"slap" | "pop" | null> = {
  decide: (seen) => nextOf(["slap", "pop"] as const, (seen[0] && slapPopOf(seen[0].markings)) ?? undefined) ?? null,
  turn: ({ markings }, next) => (slapPopOf(markings) === next ? null : { set: { slap: next === "slap" || null, pop: next === "pop" || null } }),
};

/** Whether a beat, as read, is slapped or popped (reading keeps slap only when it has both). */
function slapPopOf({ slap, pop }: BeatMarkings): "slap" | "pop" | null {
  return slap ? "slap" : pop ? "pop" : null;
}

/** The text over a beat (docs/spec/commands.md, 5.5): this text, or none for an empty one. */
function beatText(text: string): BeatChange<void> {
  return {
    decide: () => undefined,
    turn: ({ markings }) => ((markings.text ?? "") === text ? null : { set: { text: text === "" ? null : text } }),
  };
}

/**
 * Put a text over the beat of the cursor (a chord name, say: never read nor transposed), one
 * command; an empty text takes it away. False, and nothing set, for a text longer than
 * `MAX_BEAT_TEXT` (docs/spec/schema.md, section 13). Nothing in the append slot.
 */
export function setText(doc: Y.Doc, cursor: Cursor, text: string): boolean {
  if (text.length > MAX_BEAT_TEXT) return false;
  changeBeatAt(doc, cursor, beatText(text));
  return true;
}

/** The text over the beat of the cursor, empty for none; null in the append slot, or on a beat reading leaves out. */
export function textAt(doc: Y.Doc, cursor: Cursor): string | null {
  const reader = readerOf(doc, cursor.partId);
  const beat = beatAt(doc, cursor);
  const read = reader && beat && seenBeat(reader, beat);
  return read ? (read.markings.text ?? "") : null;
}

/**
 * Give the score a title, one command (docs/spec/commands.md, 7.3): 1 to 100 characters; false,
 * and nothing set, for any other length. The same title writes nothing.
 */
export function setTitle(doc: Y.Doc, title: string): boolean {
  if (title.length < 1 || title.length > MAX_TITLE) return false;
  writeField(metaOf(doc), "title", metaSchema.shape.title, title);
  return true;
}

const artistSchema = metaSchema.shape.artist.unwrap();

/**
 * Name who plays the score, one command (docs/spec/commands.md, 7.3): up to 100 characters, an
 * empty name taking it away. False, and nothing set, for a longer one. The same name writes nothing.
 */
export function setArtist(doc: Y.Doc, artist: string): boolean {
  if (artist.length > MAX_TITLE) return false;
  writeField(metaOf(doc), "artist", artistSchema, artist === "" ? undefined : artist);
  return true;
}

// Parts (docs/spec/commands.md, 7.1 and 7.2) ------------------------------------------------------

/**
 * Why a command on parts did nothing: the score has as many parts as it may (`MAX_PARTS`, or
 * `MAX_NON_PERCUSSION_PARTS` but drums), or the part is the last one, which cannot be deleted.
 */
export type PartRefusal = "tooManyParts" | "lastPart";

/**
 * Whether a part of `kind` may be added (docs/spec/commands.md, 7.1): the parts of the score, in
 * score order, with it, stay within both limits (`withinPartLimits`). A part whose kind cannot be
 * read counts as one that is not drums: never fewer parts than the document holds.
 */
export function canAddPart(doc: Y.Doc, kind: PartKind): boolean {
  const parts = partsOf(doc);
  const kinds = ordered(parts).map((id) => partKindOf(parts.get(id)) ?? "fretted");
  return withinPartLimits([...kinds, kind]);
}

/**
 * Add a part after the last one, as `addPart` does, one command: refused when the score would
 * have more parts than it may (`canAddPart`). Two members adding parts at once can still pass the
 * limits; such a score reads as usual (docs/spec/commands.md, 7.1).
 */
export function addPartWithin(doc: Y.Doc, part: NewPart): string | PartRefusal {
  return canAddPart(doc, part.kind) ? addPart(doc, part) : "tooManyParts";
}

/**
 * Delete a part, with all it holds, one command: an undo brings it back as it was
 * (docs/spec/commands.md, 7.1). The member is asked first (`barsWithContent`), not here. False
 * when the part is gone; `"lastPart"` for the only part of the score, which is kept.
 */
export function deletePart(doc: Y.Doc, partId: string): boolean | PartRefusal {
  const parts = partsOf(doc);
  if (!parts.has(partId)) return false;
  if (ordered(parts).every((id) => id === partId)) return "lastPart";
  doc.transact(() => parts.delete(partId), LOCAL);
  return true;
}

/**
 * Move a part right after another (`after`; null puts it first), one command: only its own
 * ordering key changes, a new one from `keysAfter`, so that two members moving parts at once each
 * keep theirs where they put it (docs/spec/schema.md, section 1). False, and nothing changed, when
 * either part is gone or they are the same; true, writing nothing, when it is already there.
 */
export function movePart(doc: Y.Doc, partId: string, after: string | null): boolean {
  const parts = partsOf(doc);
  const part = parts.get(partId);
  const order = ordered(parts);
  if (part === undefined || !order.includes(partId) || after === partId) return false;
  const rest = order.filter((id) => id !== partId);
  const index = after === null ? -1 : rest.indexOf(after);
  if (after !== null && index < 0) return false;
  if (order[index + 1] === partId) return true;
  doc.transact(() => part.set("order", keysAfter(parts, rest, index, 1)[0]), LOCAL);
  return true;
}

const partNameSchema = partSchemas.fretted.shape.name;

/** Rename a part, one command: 1 to 64 characters, else false and nothing set; false when the part is gone. The same name writes nothing. */
export function setPartName(doc: Y.Doc, partId: string, name: string): boolean {
  const part = partsOf(doc).get(partId);
  if (part === undefined || name.length < 1 || !partNameSchema.safeParse(name).success) return false;
  writeField(part, "name", partNameSchema, name);
  return true;
}

/** A part whose kind reads as one of `kinds`; undefined when it is gone or of another kind. */
function partOfKind(doc: Y.Doc, partId: string, kinds: readonly PartKind[]): YPart | undefined {
  const part = partsOf(doc).get(partId);
  const kind = partKindOf(part);
  return kind !== undefined && kinds.includes(kind) ? part : undefined;
}

const tuningSchema = partSchemas.fretted.shape.tuning;

/**
 * Tune a fretted part, one command (docs/spec/commands.md, 7.2): the whole tuning replaced, from
 * the first string, as many strings as it has. Frets stay, so the notes sound at new pitches.
 * False, and nothing set, for another number of strings or a pitch out of 0 to 127, or for a part
 * that is not fretted, is gone, or whose tuning cannot be read. The same tuning writes nothing.
 */
export function setTuning(doc: Y.Doc, partId: string, tuning: readonly number[]): boolean {
  const part = partOfKind(doc, partId, ["fretted"]);
  const valid = parsePlain(tuningSchema, [...tuning]);
  if (part === undefined || !valid.success || valid.data.length !== stringCountOf(part)) return false;
  writeField(part, "tuning", tuningSchema, valid.data);
  return true;
}

const capoSchema = partSchemas.fretted.shape.capo;

/** Put the capo of a fretted part on a fret, 0 (none) to 24, one command; false, and nothing set, otherwise or for any other part. The same fret writes nothing. */
export function setCapo(doc: Y.Doc, partId: string, capo: number): boolean {
  const part = partOfKind(doc, partId, ["fretted"]);
  if (part === undefined || !capoSchema.safeParse(capo).success) return false;
  writeField(part, "capo", capoSchema, capo);
  return true;
}

const programSchema = partSchemas.fretted.shape.program;

/**
 * Give a part the General MIDI program, 0 to 127, it is played with, one command; false, and
 * nothing set, otherwise or for drums, which play on the percussion channel. The same program
 * writes nothing.
 */
export function setProgram(doc: Y.Doc, partId: string, program: number): boolean {
  const part = partOfKind(doc, partId, ["fretted", "pitched"]);
  if (part === undefined || !programSchema.safeParse(program).success) return false;
  writeField(part, "program", programSchema, program);
  return true;
}

const pitchedStavesSchema = partSchemas.pitched.shape.staves;

/** A clef a staff of a pitched part can have. */
export type PitchedClef = z.output<typeof pitchedStavesSchema>[number]["clef"];

/** The clefs a staff of a pitched part can have, in the order the panel offers them. */
export const PITCHED_CLEFS: readonly PitchedClef[] = pitchedStavesSchema.element.shape.clef.options;

/**
 * Give a staff of a pitched part (0 is the first) a clef, one command (docs/spec/commands.md,
 * 7.2): the staves are replaced whole, as many as before. It only changes how the staff is drawn:
 * notes are keyed by pitch. False, and nothing set, for a staff it has not or a clef it cannot
 * have, or for a part that is not pitched: neither a fretted part's tablature nor the drum staff
 * changes. Staves that cannot be read are read as the default (one treble staff) and written over
 * from that. The same clef writes nothing.
 */
export function setClef(doc: Y.Doc, partId: string, staff: number, clef: PitchedClef): boolean {
  const part = partOfKind(doc, partId, ["pitched"]);
  if (part === undefined) return false;
  const read = parsePlain(pitchedStavesSchema, part.get("staves"));
  const staves = read.success ? read.data : KIND_DEFAULTS.pitched.staves;
  if (!Number.isInteger(staff) || staff < 0 || staff >= staves.length) return false;
  const next = parsePlain(
    pitchedStavesSchema,
    staves.map((each, index) => ({ clef: index === staff ? clef : each.clef })),
  );
  if (!next.success) return false;
  writeField(part, "staves", pitchedStavesSchema, next.data);
  return true;
}

/**
 * How many bars of the score a part holds something in: a beat, a rest too, in any voice it has
 * (docs/spec/commands.md, 7.1). What the member is told before deleting it.
 */
export function barsWithContent(score: ScoreJSON, partId: string): number {
  const part = score.parts.find((each) => each.id === partId);
  if (part === undefined) return 0;
  return score.bars.filter((bar) => Object.values(part.content[bar.id] ?? {}).some((beats) => beats.length > 0)).length;
}

/**
 * The cursor at the first place of the first voice of a bar of a part: its first beat, or the
 * append slot of an empty voice. On `line`, else where the part starts (`startLine`).
 */
export function cursorAt(doc: Y.Doc, partId: string, barId: string, line = startLine(partKindOf(partsOf(doc).get(partId)))): Cursor {
  const cursor: Cursor = { partId, barId, voice: MAIN_VOICE, beatId: null, at: "after", line };
  const voice = voiceAt(doc, cursor);
  return voice && voice.length > 0 ? { ...cursor, beatId: voice.get(0).get("id") as string, at: "on" } : cursor;
}

/**
 * Where a cursor goes when its part or bar is gone (docs/spec/commands.md, section 2): the first
 * place of the first bar of the first part that is drawn (its kind can be read), on the line it
 * had there last (`lines`, by part), else where the part starts. Null for a score with no such
 * part or no bars.
 */
export function startOfScore(doc: Y.Doc, lines: ReadonlyMap<string, number> = new Map()): Cursor | null {
  const parts = partsOf(doc);
  const partId = ordered(parts).find((id) => partKindOf(parts.get(id)) !== undefined);
  const barId = ordered(barsOf(doc))[0];
  if (partId === undefined || barId === undefined) return null;
  const line = lines.get(partId);
  return line === undefined ? cursorAt(doc, partId, barId) : cursorAt(doc, partId, barId, line);
}
