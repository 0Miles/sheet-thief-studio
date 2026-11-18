// Reading a score into plain data (docs/spec/schema.md sections 11 and 12). The server does not
// check what editors send, so a document may hold anything: what does not fit the schema is
// left out, or read as its default, and reported as an invalidContent flag. Reading never throws.
import * as Y from "yjs";
import type { z } from "zod";

import type { InvalidContentFlag } from "./flags";
import {
  barSchema,
  type BarJSON,
  type BeatJSON,
  barsOf,
  COMMON_TIME,
  KIND_DEFAULTS,
  kindSchemas,
  metaOf,
  metaSchema,
  type NoteJSON,
  ordered,
  parsePlain,
  type PartJSON,
  type PartKind,
  partKindOf,
  partSchemas,
  partsOf,
  readableVoicesIn,
  readNote,
  SCHEMA_VERSION,
  type ScoreJSON,
  contentMapOf,
  type YBeat,
} from "./schema";

/** Where something stands in the score, as far as it is known. */
type Place = Omit<InvalidContentFlag, "kind" | "what">;

/** What a part needs to check its beats: a beat checked for one fit is checked again for another. */
interface Fit {
  kind: PartKind;
  strings: number;
  /** The fit as `kind:strings`, to tell it from another. */
  key: string;
  /** Whether beats checked before may be used: not while a transaction is changing the document. */
  reuse: boolean;
}

/** A beat as last checked: what it reads as (null when it cannot be read) and what was wrong in it. */
interface Checked {
  /** The key of the fit it was checked for. */
  checkedFor: string;
  beat: BeatJSON | null;
  invalid: InvalidContentFlag[];
}

/** Every beat checked, until something changes in its bar (`watch`). */
const checked = new WeakMap<YBeat, Checked>();

const watched = new WeakSet<Y.Doc>();

/**
 * The transactions of each document that are running, or ended with their changes not yet
 * forgotten. While there is any, checks are neither reused nor kept.
 */
const unsettled = new WeakMap<Y.Doc, Set<Y.Transaction>>();

/**
 * Call `opened` when a transaction of the document starts (at once for one already running) and
 * `ended` when it has ended, before any of its observers is called. Two Yjs internals, kept in
 * this one place: `doc._transaction` and the `beforeObserverCalls` event. Neither is part of the
 * documented API; tests/cache.test.ts locks both, and yjs is pinned to ~13.6.33.
 */
function followTransactions(doc: Y.Doc, opened: (transaction: Y.Transaction) => void, ended: (transaction: Y.Transaction) => void): void {
  if (doc._transaction !== null) opened(doc._transaction);
  doc.on("beforeTransaction", opened);
  doc.on("beforeObserverCalls", ended);
}

/** Any shared type of a document, as a transaction names the ones it changed. */
type YType = Y.Transaction["changed"] extends Map<infer T, unknown> ? T : never;

/** The content of a bar (a map in the content of a part) that holds a changed type, if any. */
function barContentAbove(type: YType, parts: object): YType | null {
  for (let node: YType | null = type; node !== null; node = node.parent) {
    if (node.parent?.parent?.parent === parts) return node;
  }
  return null;
}

/**
 * Forget the beats checked in the content of a bar as soon as anything in it changes, whoever
 * changes it: when the transaction ends, before any observer is called, so that an observer
 * reading the score sees the change. While a transaction is unsettled, reading checks every beat.
 */
function watch(doc: Y.Doc): void {
  if (watched.has(doc)) return;
  watched.add(doc);
  const parts = partsOf(doc);
  const pending = new Set<Y.Transaction>();
  unsettled.set(doc, pending);
  followTransactions(doc, (transaction) => pending.add(transaction), (transaction) => {
    pending.delete(transaction);
    // One transaction can change a bar many times: forget its beats once.
    const bars = new Set<YType>();
    for (const type of transaction.changed.keys()) {
      const bar = barContentAbove(type, parts);
      if (bar !== null) bars.add(bar);
    }
    for (const voices of bars) {
      if (!(voices instanceof Y.Map)) continue;
      for (const beats of voices.values()) if (beats instanceof Y.Array) beats.forEach((beat) => beat instanceof Y.Map && checked.delete(beat));
    }
  });
}

function flag(place: Place, what: string): InvalidContentFlag {
  return { kind: "invalidContent", ...place, what };
}

/** The value of a field as its schema reads it, or `fallback` and a flag when it does not fit. */
function readField<T>(schema: z.ZodType<T>, value: unknown, fallback: T, invalid: InvalidContentFlag[], place: Place, what: string): T {
  const parsed = parsePlain(schema, value);
  if (parsed.success) return parsed.data;
  invalid.push(flag(place, what));
  return fallback;
}

/** The fields of a beat but its notes, as they are in the document: only those present. */
function fieldsOf(beat: YBeat): Record<string, unknown> {
  const fields: [string, unknown][] = [];
  beat.forEach((value, name) => {
    if (name !== "notes") fields.push([name, value]);
  });
  // Built from entries, so that a field named __proto__ is a field like any other.
  return Object.fromEntries(fields);
}

/** The fields of a beat but its notes as reading takes them: commands never put slap and pop on one beat; when co-editing does, slap stays and pop is dropped. */
function beatFieldsOf(beat: YBeat): { fields: Record<string, unknown>; poppedOff: boolean } {
  const fields = fieldsOf(beat);
  const poppedOff = fields.slap === true && fields.pop === true;
  if (poppedOff) delete fields.pop;
  return { fields, poppedOff };
}

/** The fields of a beat but its notes, as reading reads them. */
export type BeatFields = Omit<BeatJSON, "notes">;

/**
 * The fields of a beat of a part of `kind` but its notes, as reading reads them (pop dropped when
 * slap is there too); undefined when reading leaves the beat out (docs/spec/schema.md, section
 * 11): its own fields do not fit the kind, or its notes are not a map.
 */
export function readBeatFields(kind: PartKind, beat: unknown): BeatFields | undefined {
  if (!(beat instanceof Y.Map) || !(beat.get("notes") instanceof Y.Map)) return undefined;
  const parsed = parsePlain(kindSchemas[kind].beat, beatFieldsOf(beat).fields);
  return parsed.success ? parsed.data : undefined;
}

/** Whether reading keeps a beat of a part of `kind` (docs/spec/schema.md, section 11): its own fields fit the kind and its notes are a map; the notes themselves are read one by one. */
export function readsAsBeat(kind: PartKind, beat: unknown): beat is YBeat {
  return readBeatFields(kind, beat) !== undefined;
}

function checkBeat(beat: YBeat, { kind, strings }: Fit, place: Place): Omit<Checked, "checkedFor"> {
  const { fields, poppedOff } = beatFieldsOf(beat);
  const at: Place = typeof fields.id === "string" ? { ...place, beatId: fields.id } : place;
  const invalid: InvalidContentFlag[] = poppedOff ? [flag(at, "beat.pop")] : [];
  const notes = beat.get("notes");
  const parsed = parsePlain(kindSchemas[kind].beat, fields);
  if (!parsed.success || !(notes instanceof Y.Map)) return { beat: null, invalid: [flag(at, "beat")] };
  const read: Record<string, NoteJSON> = {};
  // Keys in sorted order: members who put notes on a beat at the same time can hold its map in different orders.
  const entries: [string, unknown][] = [];
  notes.forEach((value: unknown, key) => entries.push([key, value]));
  for (const [key, value] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
    const note = readNote(kind, strings, key, value);
    if (note) read[key] = note;
    else invalid.push(flag({ ...at, noteKey: key }, "note"));
  }
  return { beat: { ...parsed.data, notes: read }, invalid };
}

/** The beats of a voice that can be read, checked once and again only after their bar changes. */
function readBeats(beats: Y.Array<unknown>, fit: Fit, place: Place, invalid: InvalidContentFlag[]): BeatJSON[] {
  const read: BeatJSON[] = [];
  beats.forEach((beat) => {
    if (!(beat instanceof Y.Map)) {
      invalid.push(flag(place, "beat"));
      return;
    }
    let result = fit.reuse ? checked.get(beat) : undefined;
    if (result?.checkedFor !== fit.key) {
      result = { checkedFor: fit.key, ...checkBeat(beat, fit, place) };
      // Kept only when no transaction is unsettled: one may change this beat, or have made it.
      if (fit.reuse) checked.set(beat, result);
    }
    invalid.push(...result.invalid);
    if (result.beat) read.push(result.beat);
  });
  return read;
}

/**
 * The voices of one bar of a part: the first voice of each staff always (empty is a whole-bar
 * rest), the second only when it holds beats, so that an empty second voice draws nothing.
 */
function readVoices(voices: Y.Map<unknown>, fit: Fit, staves: number, place: Place, invalid: InvalidContentFlag[]): Record<string, BeatJSON[]> {
  const read: Record<string, BeatJSON[]> = {};
  for (let staff = 0; staff < staves; staff++) read[`${staff}:0`] = [];
  const readable = readableVoicesIn(voices, staves);
  voices.forEach((_, voice) => {
    if (!readable.some(([key]) => key === voice)) invalid.push(flag({ ...place, voice }, "voice"));
  });
  for (const [voice, beats] of readable) {
    const items = readBeats(beats as Y.Array<unknown>, fit, { ...place, voice }, invalid);
    if (items.length > 0 || voice.endsWith(":0")) read[voice] = items;
  }
  return read;
}

function readPart(id: string, part: Y.Map<unknown>, barIds: string[], reuse: boolean, invalid: InvalidContentFlag[]): PartJSON | null {
  const place: Place = { partId: id };
  const kind = partKindOf(part);
  if (kind === undefined) {
    invalid.push(flag(place, "part.kind"));
    return null;
  }
  const shape = partSchemas[kind].shape;
  const tuning = parsePlain(shape.tuning, part.get("tuning"));
  if (!tuning.success) {
    invalid.push(flag(place, "part.tuning"));
    // Notes on a string cannot be placed without the tuning of the strings.
    if (kind === "fretted") return null;
  }
  const defaults = KIND_DEFAULTS[kind];
  const staves = readField(shape.staves, part.get("staves"), defaults.staves.map((staff) => ({ ...staff })), invalid, place, "part.staves");
  const strings = tuning.success ? tuning.data.length : 0;
  const fit: Fit = { kind, strings, key: `${kind}:${strings}`, reuse };
  // Built from entries, so that a bar id __proto__ is a key like any other.
  const content: [string, Record<string, BeatJSON[]>][] = [];
  const stored = contentMapOf(part);
  if (stored !== undefined) {
    for (const barId of barIds) {
      const voices: unknown = stored.get(barId);
      if (voices === undefined) continue; // not filled in yet: reads as an empty bar
      if (voices instanceof Y.Map) content.push([barId, readVoices(voices, fit, staves.length, { ...place, barId }, invalid)]);
      else invalid.push(flag({ ...place, barId }, "content"));
    }
  } else {
    invalid.push(flag(place, "part.content"));
  }
  return {
    id,
    name: readField(shape.name, part.get("name"), "", invalid, place, "part.name"),
    kind,
    tuning: tuning.success ? tuning.data : [],
    capo: readField(shape.capo, part.get("capo"), 0, invalid, place, "part.capo"),
    program: readField(shape.program, part.get("program"), defaults.program, invalid, place, "part.program"),
    staves,
    content: Object.fromEntries(content),
    // Every field was read by the schema of the kind of this part: it is a part of that kind.
  } as PartJSON;
}

/** The fields of a bar that are left out where nothing changes: all but its id and time signature. */
const BAR_FIELDS = barSchema.keyof().options.filter((name) => name !== "id" && name !== "timeSig");

function readBar(id: string, bar: Y.Map<unknown>, first: boolean, invalid: InvalidContentFlag[]): BarJSON {
  const place: Place = { barId: id };
  const read: BarJSON = { id, timeSig: readField(barSchema.shape.timeSig, bar.get("timeSig"), { ...COMMON_TIME }, invalid, place, "bar.timeSig") };
  for (const name of BAR_FIELDS) {
    const value = bar.get(name);
    // A pickup bar anywhere but first is ignored: inserting a bar before it can make one.
    if (value === undefined || (name === "anacrusis" && !first)) continue;
    const parsed = parsePlain(barSchema.shape[name], value);
    if (parsed.success) Object.assign(read, { [name]: parsed.data });
    else invalid.push(flag(place, `bar.${name}`));
  }
  return read;
}

/** Bars or parts in score order; flags those that cannot be placed in it (not maps, or without an ordering key). */
function inOrder<T>(map: Y.Map<T>, what: "bar" | "part", invalid: InvalidContentFlag[]): [string, Y.Map<unknown>][] {
  const ids = ordered(map);
  const placed = new Set(ids);
  map.forEach((item, id) => {
    if (placed.has(id)) return;
    const place: Place = what === "bar" ? { barId: id } : { partId: id };
    invalid.push(flag(place, item instanceof Y.Map ? `${what}.order` : what));
  });
  return ids.map((id) => [id, map.get(id) as Y.Map<unknown>]);
}

export interface ScoreRead {
  score: ScoreJSON;
  /** What was left out of the score, or read as its default, in the order it was read. */
  invalid: InvalidContentFlag[];
}

/**
 * The score as plain data, and what in the document could not be read. A bar that cannot be
 * read is left out of every part, so that the parts stay aligned; a part of no known kind is
 * left out whole; a beat or a note that cannot be read is left out of its voice. Beats are
 * checked again only after something in their bar changed, and every time while a transaction
 * is unsettled (running, or ended with its observers not all called yet). Treat what it returns as read-only: unchanged beats are the same objects from one read
 * to the next.
 */
export function readScore(doc: Y.Doc): ScoreRead {
  watch(doc);
  const invalid: InvalidContentFlag[] = [];
  const meta = metaOf(doc);
  const shape = metaSchema.shape;
  const version = meta.get("schemaVersion");
  const title = meta.get("title");
  const artist = meta.get("artist");
  // An empty document (no score made in it yet) reads as an empty score of this version.
  const read: ScoreJSON = {
    schemaVersion: version === undefined ? SCHEMA_VERSION : readField(shape.schemaVersion, version, SCHEMA_VERSION, invalid, {}, "meta.schemaVersion"),
    title: title === undefined ? "" : readField(shape.title, title, "", invalid, {}, "meta.title"),
    bars: [],
    parts: [],
  };
  if (artist !== undefined) {
    const parsed = parsePlain(shape.artist, artist);
    if (parsed.success && parsed.data !== undefined) read.artist = parsed.data;
    else invalid.push(flag({}, "meta.artist"));
  }
  const placed = inOrder(barsOf(doc), "bar", invalid).filter(([id]) => {
    // A bar whose id zod's records do not keep as a key could not be written back: left out of every part.
    if (barSchema.shape.id.safeParse(id).success) return true;
    invalid.push(flag({ barId: id }, "bar"));
    return false;
  });
  read.bars = placed.map(([id, bar], index) => readBar(id, bar, index === 0, invalid));
  const barIds = read.bars.map((bar) => bar.id);
  const reuse = unsettled.get(doc)?.size === 0;
  read.parts = inOrder(partsOf(doc), "part", invalid).flatMap(([id, part]) => readPart(id, part, barIds, reuse, invalid) ?? []);
  return { score: read, invalid };
}

/** The score as plain data, in score order: what versions, exports and tests read. Never throws (see readScore). */
export function docToJson(doc: Y.Doc): ScoreJSON {
  return readScore(doc).score;
}
