// The shape of a score (docs/adr/0002, docs/spec/schema.md). The zod schemas here are the only
// source of truth: every type of the score is inferred from them, and @studio/contracts only
// re-exports them. The Yjs document holds the same shape: a global sequence of bars, and parts
// that hold the content of each bar. Readers go through docToJson; writers go through the
// commands and jsonToDoc.
import * as Y from "yjs";
import { z } from "zod";

/** Version of the document schema; a document written by a newer version opens read-only. */
export const SCHEMA_VERSION = 1;

/** Origin of the transactions made by the commands of this client: the only ones its undo follows. */
export const LOCAL = "local";

/** The first voice of the first staff: where the music of a part goes unless it has more. */
export const MAIN_VOICE = "0:0";

/** Parts in a score, all kinds together. */
export const MAX_PARTS = 16;

/** Parts other than drums in a score: each needs MIDI channels of its own (docs/spec/playback.md). */
export const MAX_NON_PERCUSSION_PARTS = 15;

export const MAX_BARS = 1000;

/** An imported score, serialized as JSON in UTF-8. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/**
 * A string of `min` to `max` characters, counted as JavaScript counts them (UTF-16 code units,
 * docs/spec/schema.md section 13); zod's own length checks count code points.
 */
function text(min: number, max: number) {
  return z.string().refine((value) => value.length >= min && value.length <= max, `from ${min} to ${max} characters`);
}

const midi = z.int().min(0).max(127);

export const partKindSchema = z.enum(["fretted", "percussion", "pitched"]);
export type PartKind = z.infer<typeof partKindSchema>;

/** Note values as the denominator of a whole note, longest first: 4 is a quarter, 8 an eighth. */
export const NOTE_VALUES = [1, 2, 4, 8, 16, 32, 64] as const;
export const noteValueSchema = z.literal(NOTE_VALUES);
export type NoteValue = z.infer<typeof noteValueSchema>;

export const timeSigSchema = z.object({ numerator: z.int().min(1).max(32), denominator: z.literal([1, 2, 4, 8, 16, 32]) });
export type TimeSignature = z.infer<typeof timeSigSchema>;

/** 4/4: what a bar gets when nothing says otherwise, and what an unreadable time signature reads as. */
export const COMMON_TIME: TimeSignature = { numerator: 4, denominator: 4 };

/** `fifths` counts sharps (positive) or flats (negative). */
export const keySigSchema = z.object({ fifths: z.int().min(-7).max(7), mode: z.enum(["major", "minor"]) });
export type KeySignature = z.infer<typeof keySigSchema>;

/** `actual` notes in the time of `normal`: a triplet is 3 in the time of 2. */
export const tupletSchema = z
  .object({ actual: z.int().min(2).max(12), normal: z.int().min(1).max(12) })
  .refine((tuplet) => tuplet.actual !== tuplet.normal, "as many notes as the time of");
export type Tuplet = z.infer<typeof tupletSchema>;

// Meta ------------------------------------------------------------------------------------------

/** The fields of `meta`. The title may be empty when read (co-editing can empty it). */
export const metaSchema = z.object({
  schemaVersion: z.int().min(0),
  title: text(0, 100),
  artist: text(1, 100).optional(),
});

// Bars ------------------------------------------------------------------------------------------

/** A bar; `tempo`, `keySig` and the rest hold from this bar on, left out where nothing changes. */
export const barSchema = z.object({
  /** A key of the content of every part: never __proto__, a key zod's records and objects built by assignment do not keep. */
  id: z.string().refine((id) => id !== "__proto__", "a bar id records cannot keep"),
  timeSig: timeSigSchema,
  /** Quarter notes per minute. */
  tempo: z.number().min(20).max(400).optional(),
  keySig: keySigSchema.optional(),
  repeatStart: z.literal(true).optional(),
  /** How many times the repeat is played in all. */
  repeatEnd: z.int().min(2).max(32).optional(),
  /** The passes this bar is played on, in order. */
  voltas: z
    .array(z.int().min(1).max(8))
    .min(1)
    .refine((passes) => passes.every((pass, index) => index === 0 || pass > (passes[index - 1] as number)), "in increasing order")
    .optional(),
  section: text(1, 64).optional(),
  /** A pickup bar: only the first bar can be one. */
  anacrusis: z.literal(true).optional(),
});
export type BarJSON = z.infer<typeof barSchema>;

// Notes and beats -------------------------------------------------------------------------------

/** Every field a note can have, whatever its part; `kindSchemas` says which ones each kind has. */
export const noteSchema = z.object({
  /** Fretted parts: the fret on the string named by the key of the note; a dead note may have none. */
  fret: z.int().min(0).max(36).optional(),
  dead: z.literal(true).optional(),
  /** The note continues the one before it on the same string or pitch. */
  tie: z.literal(true).optional(),
  ghost: z.literal(true).optional(),
  accent: z.literal(true).optional(),
  staccato: z.literal(true).optional(),
  /** Hammer-on or pull-off to the next note on the string, marked on the note it starts from. */
  legato: z.literal(true).optional(),
  slideOut: z.enum(["legato", "shift", "outUp", "outDown"]).optional(),
  slideIn: z.enum(["inBelow", "inAbove"]).optional(),
  bend: z.object({ type: z.enum(["bend", "bendRelease", "preBend", "preBendRelease"]), semitones: z.int().min(1).max(4) }).optional(),
  vibrato: z.literal(true).optional(),
  palmMute: z.literal(true).optional(),
  letRing: z.literal(true).optional(),
  tap: z.literal(true).optional(),
  harmonic: z.enum(["natural", "pinch", "artificial"]).optional(),
  /** Pitched parts: how the pitch of the key is spelled ("C#", "Db", "F##" or "Fx", "Bbb"). */
  spell: z
    .string()
    .regex(/^[A-G](#|b|##|x|bb)?$/)
    .optional(),
});
export type NoteJSON = z.infer<typeof noteSchema>;

/** The fields of a beat but its notes. */
const beatFieldsSchema = z.object({
  id: z.string(),
  value: noteValueSchema,
  dots: z.literal([0, 1, 2]),
  tuplet: tupletSchema.optional(),
  stroke: z.enum(["down", "up"]).optional(),
  slap: z.literal(true).optional(),
  pop: z.literal(true).optional(),
  dynamic: z.enum(["pp", "p", "mp", "mf", "f", "ff"]).optional(),
  /** Free text over the beat, such as a chord name: never read nor transposed. */
  text: text(1, 64).optional(),
  /** One syllable; empty continues the syllable before it (melisma). */
  lyric: text(0, 32).optional(),
});

/** Every field a beat can have, whatever its part. */
export const beatSchema = beatFieldsSchema.extend({
  /** Keyed by position: "s3" a string, "p38" a drum piece, "n60" a pitch. Empty is a rest. */
  notes: z.record(z.string(), noteSchema),
});
export type BeatJSON = z.infer<typeof beatSchema>;

/** The kinds of part a field belongs to, for the fields that do not belong to every kind. */
type FieldKinds = Readonly<Partial<Record<string, readonly PartKind[]>>>;

const NOTE_FIELD_KINDS: FieldKinds = {
  fret: ["fretted"],
  dead: ["fretted"],
  tie: ["fretted", "pitched"],
  ghost: ["fretted", "percussion"],
  staccato: ["fretted", "pitched"],
  legato: ["fretted"],
  slideOut: ["fretted"],
  slideIn: ["fretted"],
  bend: ["fretted"],
  vibrato: ["fretted"],
  palmMute: ["fretted"],
  letRing: ["fretted"],
  tap: ["fretted"],
  harmonic: ["fretted"],
  spell: ["pitched"],
};

const BEAT_FIELD_KINDS: FieldKinds = { stroke: ["fretted"], slap: ["fretted"], pop: ["fretted"], lyric: ["pitched"] };

function onlyFieldsOf(kinds: FieldKinds, kind: PartKind) {
  return (value: object) => Object.entries(value).every(([field, item]) => item === undefined || (kinds[field]?.includes(kind) ?? true));
}

function kindRules(kind: PartKind) {
  const note = noteSchema.refine(onlyFieldsOf(NOTE_FIELD_KINDS, kind), "a field this kind of part does not have");
  return {
    beat: beatFieldsSchema
      .refine(onlyFieldsOf(BEAT_FIELD_KINDS, kind), "a field this kind of part does not have")
      .refine((beat) => !(beat.slap && beat.pop), "slap and pop on the same beat"),
    note: kind === "fretted" ? note.refine((item) => item.fret !== undefined || item.dead === true, "neither a fret nor dead") : note,
  };
}

/**
 * What a beat (its own fields, its notes apart) and a note of a part of each kind may hold:
 * reading checks every beat and every note of the document with these.
 */
export const kindSchemas = { fretted: kindRules("fretted"), percussion: kindRules("percussion"), pitched: kindRules("pitched") } as const;

const NOTE_KEYS: Record<PartKind, RegExp> = { fretted: /^s([1-9]\d*)$/, percussion: /^p(0|[1-9]\d*)$/, pitched: /^n(0|[1-9]\d*)$/ };

/**
 * Whether a key names a note of a part of `kind`: "s1" to "s<strings>" (1 is the highest
 * string), a drum piece "p0" to "p127" (an alphaTab percussion articulation), a pitch "n0" to
 * "n127".
 */
export function isNoteKey(kind: PartKind, strings: number, key: string): boolean {
  const match = NOTE_KEYS[kind].exec(key);
  if (match === null) return false;
  return Number(match[1]) <= (kind === "fretted" ? strings : 127);
}

/** Whether a key names a voice of a part with `staves` staves: "<staff>:<voice>", each voice 0 or 1. */
export function isVoiceKey(key: string, staves: number): boolean {
  return voiceKeys(staves).includes(key);
}

/** Every voice of a part with `staves` staves, in order: "0:0", "0:1", "1:0", "1:1". */
export function voiceKeys(staves: number): string[] {
  return Array.from({ length: staves }, (_, staff) => [`${staff}:0`, `${staff}:1`]).flat();
}

// Parts -----------------------------------------------------------------------------------------

/** Bar id, then voice ("staff:voice"), to its beats. A bar or voice left out is empty. */
const contentSchema = z.record(z.string(), z.record(z.string(), z.array(beatSchema)));

/** The name may be empty when read: an unreadable name reads as empty (section 11). */
const partName = text(0, 64);

/**
 * The fields of a part of each kind. `tuning` is the MIDI pitch of each open string, from the
 * first (highest) string; `program` the General MIDI program it is played with.
 */
export const partSchemas = {
  fretted: z.object({
    id: z.string(),
    name: partName,
    kind: z.literal("fretted"),
    tuning: z.array(midi).min(4).max(7),
    capo: z.int().min(0).max(24),
    program: midi,
    staves: z.tuple([z.object({ clef: z.literal("tab") })]),
    content: contentSchema,
  }),
  percussion: z.object({
    id: z.string(),
    name: partName,
    kind: z.literal("percussion"),
    tuning: z.tuple([]),
    capo: z.literal(0),
    /** Drums play on the percussion channel. */
    program: z.literal(0),
    staves: z.tuple([z.object({ clef: z.literal("neutral") })]),
    content: contentSchema,
  }),
  pitched: z.object({
    id: z.string(),
    name: partName,
    kind: z.literal("pitched"),
    tuning: z.tuple([]),
    capo: z.literal(0),
    program: midi,
    /** The clef only changes how the staff is drawn: notes are keyed by pitch. */
    staves: z
      .array(z.object({ clef: z.enum(["treble", "bass", "treble-8vb"]) }))
      .min(1)
      .max(2),
    content: contentSchema,
  }),
};

/** A part, its content checked against its kind: voices of its staves, notes of its kind. */
export const partSchema = z.discriminatedUnion("kind", [partSchemas.fretted, partSchemas.percussion, partSchemas.pitched]).superRefine((part, context) => {
  const rules = kindSchemas[part.kind];
  for (const [barId, voices] of Object.entries(part.content)) {
    for (const [voice, beats] of Object.entries(voices)) {
      const path = ["content", barId, voice];
      if (!isVoiceKey(voice, part.staves.length)) context.addIssue({ code: "custom", message: "not a voice of this part", path });
      beats.forEach((beat, index) => {
        if (!rules.beat.safeParse(beat).success) context.addIssue({ code: "custom", message: "not a beat of this kind of part", path: [...path, index] });
        for (const [key, note] of Object.entries(beat.notes)) {
          if (isNoteKey(part.kind, part.tuning.length, key) && rules.note.safeParse(note).success) continue;
          context.addIssue({ code: "custom", message: "not a note of this part", path: [...path, index, "notes", key] });
        }
      });
    }
  }
});
export type PartJSON = z.infer<typeof partSchema>;
export type Staff = PartJSON["staves"][number];

/** What a part of each kind gets when nothing says otherwise: on creation, or when its own field cannot be read. */
export const KIND_DEFAULTS: Record<PartKind, { program: number; staves: Staff[] }> = {
  fretted: { program: 25, staves: [{ clef: "tab" }] },
  percussion: { program: 0, staves: [{ clef: "neutral" }] },
  pitched: { program: 0, staves: [{ clef: "treble" }] },
};

// The score -------------------------------------------------------------------------------------

/**
 * The score as plain data, in score order: what versions, exports, imports and tests read and
 * write. How many bars and parts it has is not limited here: members adding them at the same
 * time can pass the limits, and a version of such a score must still be read and restored. The
 * limits bind the commands and import (importedScoreSchema).
 */
export const scoreSchema = metaSchema
  .extend({
    /** In score order. */
    bars: z.array(barSchema),
    /** In score order. */
    parts: z.array(partSchema),
  })
  .superRefine((score, context) => {
    const issue = (message: string, path: (string | number)[]) => context.addIssue({ code: "custom", message, path });
    const barIds = new Set(score.bars.map((bar) => bar.id));
    if (barIds.size < score.bars.length) issue("two bars with the same id", ["bars"]);
    if (new Set(score.parts.map((part) => part.id)).size < score.parts.length) issue("two parts with the same id", ["parts"]);
    score.bars.forEach((bar, index) => {
      if (index > 0 && bar.anacrusis) issue("a pickup bar that is not the first", ["bars", index, "anacrusis"]);
    });
    score.parts.forEach((part, index) => {
      for (const barId of Object.keys(part.content)) if (!barIds.has(barId)) issue("content for a bar that is not in the score", ["parts", index, "content", barId]);
    });
  });
export type ScoreJSON = z.infer<typeof scoreSchema>;

/** How many bytes a string takes in UTF-8. */
function utf8Length(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const code = character.codePointAt(0) as number;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * A score to import as a new one (section 13): a legal score within the limits on bars and
 * parts, of at most 5 MB once serialized.
 */
export const importedScoreSchema = scoreSchema.superRefine((score, context) => {
  const issue = (message: string, path: string[]) => context.addIssue({ code: "custom", message, path });
  if (score.bars.length > MAX_BARS) issue(`more than ${MAX_BARS} bars`, ["bars"]);
  if (score.parts.length > MAX_PARTS) issue(`more than ${MAX_PARTS} parts`, ["parts"]);
  if (score.parts.filter((part) => part.kind !== "percussion").length > MAX_NON_PERCUSSION_PARTS) issue(`more than ${MAX_NON_PERCUSSION_PARTS} parts that are not drums`, ["parts"]);
  if (utf8Length(JSON.stringify(score)) > MAX_IMPORT_BYTES) issue(`more than ${MAX_IMPORT_BYTES} bytes of JSON`, []);
});

// The Yjs document ------------------------------------------------------------------------------

export type YBeat = Y.Map<unknown>;
export type YVoice = Y.Array<YBeat>;
export type YBarContent = Y.Map<YVoice>;
export type YPart = Y.Map<unknown>;
export type YBar = Y.Map<unknown>;

export function metaOf(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap("meta");
}

export function barsOf(doc: Y.Doc): Y.Map<YBar> {
  return doc.getMap("bars");
}

export function partsOf(doc: Y.Doc): Y.Map<YPart> {
  return doc.getMap("parts");
}

export function contentOf(part: YPart): Y.Map<YBarContent> {
  return part.get("content") as Y.Map<YBarContent>;
}

/** The content of a part only when it is a map (contentOf trusts the document): undefined when the part or its content is not one. */
export function contentMapOf(part: unknown): Y.Map<unknown> | undefined {
  const content: unknown = part instanceof Y.Map ? part.get("content") : undefined;
  return content instanceof Y.Map ? content : undefined;
}

/**
 * Ids in score order: by ordering key, then by id, so that equal keys sort the same everywhere.
 * Entries that are not maps or have no ordering key are left out, as reading leaves them out.
 */
export function ordered<T>(map: Y.Map<T>): string[] {
  const keyed: [string, string][] = [];
  map.forEach((value, id) => {
    const order = value instanceof Y.Map ? value.get("order") : undefined;
    if (typeof order === "string") keyed.push([order, id]);
  });
  return keyed.sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0)).map(([, id]) => id);
}

/** The kind of a part, or undefined when it is not a part or its kind cannot be read (docs/spec/schema.md, section 11). */
export function partKindOf(part: unknown): PartKind | undefined {
  const kind = partKindSchema.safeParse(part instanceof Y.Map ? part.get("kind") : undefined);
  return kind.success ? kind.data : undefined;
}

/** How many staves a part has: as its `staves` say, or as its kind has by default when they cannot be read. */
export function staffCountOf(part: YPart): number {
  const kind = partKindOf(part);
  if (kind === undefined) return 1;
  const staves = partSchemas[kind].shape.staves.safeParse(part.get("staves"));
  return staves.success ? staves.data.length : KIND_DEFAULTS[kind].staves.length;
}

/**
 * The content of one bar of a part, every voice of every staff in place: two members writing
 * the first beats of the same voice at once would each make the voice, and one would lose
 * them (docs/adr/0002, addendum).
 */
export function emptyBarContent(staves: number): YBarContent {
  const content: YBarContent = new Y.Map();
  for (const voice of voiceKeys(staves)) content.set(voice, new Y.Array<YBeat>());
  return content;
}
