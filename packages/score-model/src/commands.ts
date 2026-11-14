// Editing commands: each changes the document in one transaction (one undo step) and returns
// where the cursor is afterwards. They never touch the DOM or the renderer.
import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";
import { nanoid } from "nanoid";
import * as Y from "yjs";

import {
  barsOf,
  COMMON_TIME,
  contentOf,
  type BeatDuration,
  type Duration,
  durationOf,
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
  partKindOf,
  partsOf,
  readNote,
  SCHEMA_VERSION,
  type Staff,
  staffCountOf,
  stringCountOf,
  contentMapOf,
  type TimeSignature,
  type Tuplet,
  type YBar,
  type YBeat,
  type YPart,
  voiceIn,
  type YVoice,
  voiceKeys,
} from "./schema";
import { startLine } from "./navigation";
import { readsAsBeat } from "./read";
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
 * Write a note at the cursor, one command: on its beat, or in the append slot on a new beat made
 * there (as `insertBeat` makes it), the cursor then on that beat. `write` gets the note stored
 * at `key` and returns the new one, or null to remove it; removing makes no beat.
 */
function writeNote(doc: Y.Doc, cursor: Cursor, key: string, write: (stored: NoteJSON | undefined) => NoteJSON | null): Cursor {
  if (cursor.at === "after") {
    const note = write(undefined);
    const place = placeFor(doc, cursor);
    if (note === null || place === undefined) return cursor;
    return makeBeat(doc, cursor, place, place.duration, (notes) => notes.set(key, note));
  }
  const beat = beatAt(doc, cursor);
  if (beat === undefined) return cursor;
  const notes = beat.get("notes") as Y.Map<NoteJSON>;
  const stored = notes.get(key);
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
export const ON_OFF_TECHNIQUES = ["dead", "ghost", "accent", "staccato", "vibrato", "palmMute", "letRing", "tap"] as const;
export type OnOffTechnique = (typeof ON_OFF_TECHNIQUES)[number];

/**
 * Where a note a toggle turns stands: its key, and the note with the same key on the beat before
 * in its voice (the last beat of the bar before, for the first beat of a bar), when one can be read.
 */
export interface NotePlace {
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
   * The note at `place` once turned to `decided`, from the note as stored (fields this version
   * does not know are kept; undefined where there is none): null for no note there, removing one
   * stored; `stored` itself to leave it as it is, which writes nothing.
   */
  turn(stored: NoteJSON | undefined, decided: D, place: NotePlace): NoteJSON | null;
}

/** An on/off technique but dead (`deadToggle`): on, or off when every note seen has it, on the notes there are; it makes none. */
export function onOffToggle(technique: Exclude<OnOffTechnique, "dead">): NoteToggle<boolean> {
  return plainToggle(technique);
}

function plainToggle(technique: OnOffTechnique): NoteToggle<boolean> {
  return {
    decide: (seen) => !seen.every((note) => note[technique] === true),
    turn(stored, on) {
      if (stored === undefined || (stored[technique] === true) === on) return stored ?? null;
      if (on) return { ...stored, [technique]: true };
      const note = { ...stored };
      delete note[technique];
      return note;
    },
  };
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
function notesBefore(doc: Y.Doc, reader: PartReader, at: { partId: string; barId: string; voice: string }, voice: YVoice, index: number): Y.Map<NoteJSON> | undefined {
  const own = lastReadNotes(reader, voice, index);
  if (own !== undefined) return own;
  const bars = ordered(barsOf(doc));
  const previous = bars[bars.indexOf(at.barId) - 1];
  const before = previous === undefined ? undefined : voiceIn(doc, { ...at, barId: previous });
  return before && lastReadNotes(reader, before, before.length);
}

/**
 * Change the note at `key` of the cursor's beat with a technique, one command: the toggle decides
 * from that note, or from none when the line is empty. In the append slot a note it makes goes on
 * a new beat (as a digit does), the cursor then on it. A note reading leaves out is not seen and
 * is left alone (docs/spec/schema.md, section 11).
 */
export function toggleAt<D>(doc: Y.Doc, cursor: Cursor, key: string, toggle: NoteToggle<D>): Cursor {
  const reader = readerOf(doc, cursor.partId);
  const place = placeFor(doc, cursor);
  if (reader === undefined || place === undefined) return cursor;
  const stored = cursor.at === "on" ? notesOf(place.voice.get(place.index))?.get(key) : undefined;
  const seen = reader.note(key, stored);
  if (stored !== undefined && seen === undefined) return cursor;
  // On a beat, the beat before it; in the append slot, the anchor the new beat goes after.
  const before = reader.note(key, notesBefore(doc, reader, cursor, place.voice, place.index)?.get(key));
  const decided = toggle.decide(seen === undefined ? [] : [seen]);
  return writeNote(doc, cursor, key, (note) => toggle.turn(note, decided, { key, before }));
}

/** The beats of one voice a selection holds, first to last, and where they are: to find the beat before each. */
interface SelectedRun {
  barId: string;
  voiceKey: string;
  voice: YVoice;
  first: number;
  last: number;
}

/** What a selection holds in the part selected: its beats in its voice, or every voice of the part in the bars of a bar range. */
function runsOf(doc: Y.Doc, selection: Selection): SelectedRun[] {
  if (selection.kind === "beats") {
    const found = selectedBeats(doc, selection);
    return found ? [{ barId: selection.barId, voiceKey: selection.voice, ...found }] : [];
  }
  const part = partsOf(doc).get(selection.partId);
  if (part === undefined) return [];
  return selectedBars(doc, selection).flatMap((barId) =>
    [...(contentOf(part).get(barId)?.entries() ?? [])].map(([voiceKey, voice]) => ({ barId, voiceKey, voice, first: 0, last: voice.length - 1 })),
  );
}

/** A beat of a selection that reading keeps, and where it is. */
interface SelectedBeat {
  at: { partId: string; barId: string; voice: string };
  voice: YVoice;
  index: number;
  beat: YBeat;
}

/**
 * The beats of a selection, in the part selected, runs in score order and beats in the order of
 * their voice; those reading leaves out are not among them.
 */
function selectedBeatsOf(doc: Y.Doc, reader: PartReader, selection: Selection): SelectedBeat[] {
  return runsOf(doc, selection).flatMap(({ barId, voiceKey, voice, first, last }) =>
    Array.from({ length: last - first + 1 }, (_, offset) => first + offset).flatMap((index) => {
      const beat = voice.get(index);
      return readsAsBeat(reader.kind, beat) ? [{ at: { partId: selection.partId, barId, voice: voiceKey }, voice, index, beat }] : [];
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
  const beats = selectedBeatsOf(doc, reader, selection).map(({ at, voice, index, beat }) => {
    const map = notesOf(beat) as Y.Map<NoteJSON>;
    const notes = [...map.entries()].flatMap(([key, stored]) => {
      const seen = reader.note(key, stored);
      return seen ? [{ key, stored, seen }] : [];
    });
    return { at, voice, index, map, notes };
  });
  const seen = beats.flatMap(({ notes }) => notes.map((note) => note.seen));
  if (seen.length === 0) return cursor;
  const decided = toggle.decide(seen);
  // What each note of the selection has become, by the notes of its beat: runs come in score order, beats in voice order.
  const turned = new Map<Y.Map<NoteJSON>, Map<string, NoteJSON | null>>();
  const changes: { map: Y.Map<NoteJSON>; key: string; next: NoteJSON | null }[] = [];
  for (const { at, voice, index, map, notes } of beats) {
    const before = notesBefore(doc, reader, at, voice, index);
    const earlier = before && turned.get(before);
    const results = new Map<string, NoteJSON | null>();
    turned.set(map, results);
    for (const { key, stored } of notes) {
      const previous = earlier?.has(key) ? (earlier.get(key) ?? undefined) : reader.note(key, before?.get(key));
      const next = toggle.turn(stored, decided, { key, before: previous });
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

/** A beat as a `BeatChange` sees it: how long it lasts, and whether it is a rest. */
export interface SeenBeat {
  duration: BeatDuration;
  rest: boolean;
}

/** What a `BeatChange` writes on a beat: a note value, dots, a tuplet (null takes it away), or its notes taken away. */
export interface BeatEdit {
  value?: NoteValue;
  dots?: 0 | 1 | 2;
  tuplet?: Tuplet | null;
  clear?: true;
}

/**
 * A change a key makes to whole beats (docs/spec/commands.md, 5.3 and 5.6), on the cursor's beat
 * or on every beat of a selection. As with `NoteToggle`, what the beats are to become is decided
 * once, from every beat seen, then each beat is changed to it.
 */
export interface BeatChange<D> {
  decide(seen: readonly SeenBeat[]): D;
  /** What to write on a beat to make it `decided`; null to leave it as it is, which writes nothing. */
  turn(beat: SeenBeat, decided: D): BeatEdit | null;
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
 * `Shift+T`: a triplet on every beat without a tuplet, unless every beat seen has one; then every
 * tuplet comes off. A beat with a tuplet of its own keeps it while triplets go on.
 */
export const tripletToggle: BeatChange<boolean> = {
  decide: (seen) => seen.some((beat) => beat.duration.tuplet === undefined),
  turn({ duration }, on) {
    if ((duration.tuplet !== undefined) === on) return null;
    return { tuplet: on ? { ...TRIPLET } : null };
  },
};

/** `Shift+R`: every beat a rest, its notes taken away and everything else it holds kept. */
export const clearNotes: BeatChange<void> = {
  decide: () => undefined,
  turn: ({ rest }) => (rest ? null : { clear: true }),
};

/** How a `BeatChange` sees a beat; none when reading leaves it out. */
function seenBeat(reader: PartReader, beat: YBeat | undefined): SeenBeat | undefined {
  if (beat === undefined || !readsAsBeat(reader.kind, beat)) return undefined;
  const duration = durationOf(beat);
  return duration && { duration, rest: isRest(beat) };
}

/** Change beats as decided, in one transaction; none when nothing changes. */
function changeBeats<D>(doc: Y.Doc, beats: YBeat[], reader: PartReader, change: BeatChange<D>): void {
  const seen = beats.flatMap((beat) => {
    const view = seenBeat(reader, beat);
    return view ? [{ beat, view }] : [];
  });
  if (seen.length === 0) return;
  const decided = change.decide(seen.map(({ view }) => view));
  const edits = seen.flatMap(({ beat, view }) => {
    const edit = change.turn(view, decided);
    return edit === null ? [] : [{ beat, edit }];
  });
  if (edits.length === 0) return;
  doc.transact(() => {
    for (const { beat, edit } of edits) {
      if (edit.value !== undefined) beat.set("value", edit.value);
      if (edit.dots !== undefined) beat.set("dots", edit.dots);
      if (edit.tuplet === null) beat.delete("tuplet");
      else if (edit.tuplet !== undefined) beat.set("tuplet", edit.tuplet);
      if (edit.clear) notesOf(beat)?.clear();
    }
  }, LOCAL);
}

/** Change the beat of the cursor, one command; nothing in the append slot, or on a beat reading leaves out. The cursor stays. */
export function changeBeatAt<D>(doc: Y.Doc, cursor: Cursor, change: BeatChange<D>): Cursor {
  const reader = readerOf(doc, cursor.partId);
  const beat = beatAt(doc, cursor);
  if (reader !== undefined && beat !== undefined) changeBeats(doc, [beat], reader, change);
  return cursor;
}

/**
 * Change every beat of a selection, in the part selected (docs/spec/commands.md, 5.3 and 5.6),
 * one command, decided once from all of them. Beats reading leaves out are neither seen nor
 * changed. The cursor stays.
 */
export function changeBeatsOnSelection<D>(doc: Y.Doc, selection: Selection, cursor: Cursor, change: BeatChange<D>): Cursor {
  const reader = readerOf(doc, selection.partId);
  if (reader !== undefined) changeBeats(doc, selectedBeatsOf(doc, reader, selection).map(({ beat }) => beat), reader, change);
  return cursor;
}

/** Make the beat of the cursor one note value shorter (`step` 1) or longer (-1), keeping its dots. */
export function stepDuration(doc: Y.Doc, cursor: Cursor, step: 1 | -1): Cursor {
  return changeBeatAt(doc, cursor, durationStep(step));
}

/** Give the score a title, one command (docs/spec/commands.md, 7.3): 1 to 100 characters; false, and nothing set, for any other length. */
export function setTitle(doc: Y.Doc, title: string): boolean {
  if (title.length < 1 || title.length > 100) return false;
  doc.transact(() => metaOf(doc).set("title", title), LOCAL);
  return true;
}

/**
 * The cursor at the first place of the first voice of a bar of a part: its first beat, or the
 * append slot of an empty voice. On `line`, else where the part starts (`startLine`).
 */
export function cursorAt(doc: Y.Doc, partId: string, barId: string, line = startLine(partKindOf(partsOf(doc).get(partId)) ?? "fretted")): Cursor {
  const cursor: Cursor = { partId, barId, voice: MAIN_VOICE, beatId: null, at: "after", line };
  const voice = voiceAt(doc, cursor);
  return voice && voice.length > 0 ? { ...cursor, beatId: voice.get(0).get("id") as string, at: "on" } : cursor;
}
