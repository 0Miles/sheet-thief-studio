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
  isNoteKey,
  isVoiceKey,
  KIND_DEFAULTS,
  kindSchemas,
  metaOf,
  metaSchema,
  type NoteJSON,
  ordered,
  type PartJSON,
  type PartKind,
  partKindSchema,
  partSchemas,
  partsOf,
  SCHEMA_VERSION,
  type ScoreJSON,
  storedContentOf,
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

/** Forget the beats checked in the content of a bar as soon as anything in it changes, whoever changes it. */
function watch(doc: Y.Doc): void {
  if (watched.has(doc)) return;
  watched.add(doc);
  const parts = partsOf(doc);
  parts.observeDeep((events) => {
    // One transaction can change a bar many times: forget its beats once.
    const changed = new Set<Y.Map<unknown>>();
    for (const event of events) {
      // Inside the content of a bar: ["<part>", "content", "<bar>", "<voice>", index, …].
      const [partId, field, barId] = event.path;
      if (field !== "content" || typeof partId !== "string" || typeof barId !== "string") continue;
      const voices: unknown = storedContentOf(parts.get(partId))?.get(barId);
      if (voices instanceof Y.Map) changed.add(voices);
    }
    for (const voices of changed) {
      for (const beats of voices.values()) if (beats instanceof Y.Array) beats.forEach((beat) => beat instanceof Y.Map && checked.delete(beat));
    }
  });
}

function flag(place: Place, what: string): InvalidContentFlag {
  return { kind: "invalidContent", ...place, what };
}

/** The value of a field as its schema reads it, or `fallback` and a flag when it does not fit. */
function readField<T>(schema: z.ZodType<T>, value: unknown, fallback: T, invalid: InvalidContentFlag[], place: Place, what: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  invalid.push(flag(place, what));
  return fallback;
}

/** The fields of a beat but its notes, as they are in the document: only those present. */
function fieldsOf(beat: YBeat): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  beat.forEach((value, name) => {
    if (name !== "notes") fields[name] = value;
  });
  return fields;
}

function checkBeat(beat: YBeat, { kind, strings }: Fit, place: Place): Omit<Checked, "checkedFor"> {
  const fields = fieldsOf(beat);
  const at: Place = typeof fields.id === "string" ? { ...place, beatId: fields.id } : place;
  const invalid: InvalidContentFlag[] = [];
  // Commands never put both on a beat; when co-editing does, slap stays.
  if (fields.slap === true && fields.pop === true) {
    delete fields.pop;
    invalid.push(flag(at, "beat.pop"));
  }
  const notes = beat.get("notes");
  const rules = kindSchemas[kind];
  const parsed = rules.beat.safeParse(fields);
  if (!parsed.success || !(notes instanceof Y.Map)) return { beat: null, invalid: [flag(at, "beat")] };
  const read: Record<string, NoteJSON> = {};
  // Keys in sorted order: members who put notes on a beat at the same time can hold its map in different orders.
  const entries: [string, unknown][] = [];
  notes.forEach((value: unknown, key) => entries.push([key, value]));
  for (const [key, value] of entries.sort(([a], [b]) => (a < b ? -1 : 1))) {
    const note = isNoteKey(kind, strings, key) && !(value instanceof Y.AbstractType) ? rules.note.safeParse(value) : null;
    if (note?.success) read[key] = note.data;
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
    let result = checked.get(beat);
    if (result?.checkedFor !== fit.key) {
      result = { checkedFor: fit.key, ...checkBeat(beat, fit, place) };
      checked.set(beat, result);
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
  voices.forEach((beats, voice) => {
    if (!isVoiceKey(voice, staves) || !(beats instanceof Y.Array)) {
      invalid.push(flag({ ...place, voice }, "voice"));
      return;
    }
    const items = readBeats(beats, fit, { ...place, voice }, invalid);
    if (items.length > 0 || voice.endsWith(":0")) read[voice] = items;
  });
  return read;
}

function readPart(id: string, part: Y.Map<unknown>, barIds: string[], invalid: InvalidContentFlag[]): PartJSON | null {
  const place: Place = { partId: id };
  const kind = partKindSchema.safeParse(part.get("kind"));
  if (!kind.success) {
    invalid.push(flag(place, "part.kind"));
    return null;
  }
  const shape = partSchemas[kind.data].shape;
  const tuning = shape.tuning.safeParse(part.get("tuning"));
  if (!tuning.success) {
    invalid.push(flag(place, "part.tuning"));
    // Notes on a string cannot be placed without the tuning of the strings.
    if (kind.data === "fretted") return null;
  }
  const defaults = KIND_DEFAULTS[kind.data];
  const staves = readField(shape.staves, part.get("staves"), defaults.staves, invalid, place, "part.staves");
  const strings = tuning.success ? tuning.data.length : 0;
  const fit: Fit = { kind: kind.data, strings, key: `${kind.data}:${strings}` };
  const content: PartJSON["content"] = {};
  const stored = storedContentOf(part);
  if (stored !== undefined) {
    for (const barId of barIds) {
      const voices: unknown = stored.get(barId);
      if (voices === undefined) continue; // not filled in yet: reads as an empty bar
      if (voices instanceof Y.Map) content[barId] = readVoices(voices, fit, staves.length, { ...place, barId }, invalid);
      else invalid.push(flag({ ...place, barId }, "content"));
    }
  } else {
    invalid.push(flag(place, "part.content"));
  }
  return {
    id,
    name: readField(shape.name, part.get("name"), "", invalid, place, "part.name"),
    kind: kind.data,
    tuning: tuning.success ? tuning.data : [],
    capo: readField(shape.capo, part.get("capo"), 0, invalid, place, "part.capo"),
    program: readField(shape.program, part.get("program"), defaults.program, invalid, place, "part.program"),
    staves,
    content,
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
    const parsed = barSchema.shape[name].safeParse(value);
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
 * checked again only after something in their bar changed. Treat what it returns as read-only:
 * unchanged beats are the same objects from one read to the next.
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
    const parsed = shape.artist.safeParse(artist);
    if (parsed.success && parsed.data !== undefined) read.artist = parsed.data;
    else invalid.push(flag({}, "meta.artist"));
  }
  read.bars = inOrder(barsOf(doc), "bar", invalid).map(([id, bar], index) => readBar(id, bar, index === 0, invalid));
  const barIds = read.bars.map((bar) => bar.id);
  read.parts = inOrder(partsOf(doc), "part", invalid).flatMap(([id, part]) => readPart(id, part, barIds, invalid) ?? []);
  return { score: read, invalid };
}

/** The score as plain data, in score order: what versions, exports and tests read. Never throws (see readScore). */
export function docToJson(doc: Y.Doc): ScoreJSON {
  return readScore(doc).score;
}
