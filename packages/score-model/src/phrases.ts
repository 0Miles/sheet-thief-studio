// Phrase fragments (docs/spec/phrases.md, section 1): music without any id, the content of a
// phrase and of the clipboard. A fragment of bars is some bars of one part, all their voices; a
// fragment of beats is beats in a row of one voice (the clipboard only). Neither carries what the
// bars of a score share (tempo, key, repeats, sections) nor the capo.
import { z } from "zod";

import { newId, type Selection } from "./commands";
import {
  beatSchema,
  type BeatJSON,
  checkBeats,
  COMMON_TIME,
  isVoiceKey,
  jsonBytes,
  KIND_DEFAULTS,
  type PartJSON,
  type PartKind,
  partSchemas,
  SCHEMA_VERSION,
  type ScoreJSON,
  timeSigSchema,
  voiceKey,
  voiceKeys,
} from "./schema";

/** The largest fragment, serialized as JSON in UTF-8 (docs/spec/schema.md, section 13). */
export const MAX_FRAGMENT_BYTES = 1024 * 1024;

/** A beat as a fragment holds it: anything a beat of a score has but its id, which it must not have. */
const fragmentBeatSchema = beatSchema.omit({ id: true }).extend({ id: z.never().optional() });
export type BeatWithoutId = Omit<BeatJSON, "id">;

/** Fields a fragment must not have: set at all, the fragment is refused (fields it does not know are left out, as reading does). */
function none<const Fields extends readonly string[]>(fields: Fields): { [Field in Fields[number]]: z.ZodOptional<z.ZodNever> } {
  return Object.fromEntries(fields.map((field) => [field, z.never().optional()])) as { [Field in Fields[number]]: z.ZodOptional<z.ZodNever> };
}

/** A bar of a fragment: its time signature and its voices ("staff:voice" to beats); none of what the bars of a score share. */
const fragmentBarSchema = z.object({
  timeSig: timeSigSchema,
  voices: z.record(z.string(), z.array(fragmentBeatSchema)),
  ...none(["id", "tempo", "keySig", "repeatStart", "repeatEnd", "voltas", "section", "anacrusis"]),
});

const bars = z.array(fragmentBarSchema).min(1);
const beats = z.array(fragmentBeatSchema).min(1);
const { tuning } = partSchemas.fretted.shape;
const { staves } = partSchemas.pitched.shape;

function withinSize(fragment: object): boolean {
  return jsonBytes(fragment) <= MAX_FRAGMENT_BYTES;
}

/** Strings of the part a fragment comes from: those of its tuning when fretted, none otherwise. */
function stringsOf(fragment: { tuning?: readonly number[] }): number {
  return fragment.tuning?.length ?? 0;
}

/** What no fragment has: an id, a capo, the fields of a part's other kinds, and the other fragment's beats or bars. */
const notOfBars = none(["id", "capo", "beats"]);
const notOfBeats = none(["id", "capo", "bars", "staves"]);

/** Bars of one part: its kind, the tuning of a fretted part and the staves of a pitched one. */
export const barsFragmentSchema = z
  .discriminatedUnion("kind", [
    z.object({ ...notOfBars, ...none(["staves"]), kind: z.literal("fretted"), tuning, bars }),
    z.object({ ...notOfBars, ...none(["tuning", "staves"]), kind: z.literal("percussion"), bars }),
    z.object({ ...notOfBars, ...none(["tuning"]), kind: z.literal("pitched"), staves, bars }),
  ])
  .superRefine((fragment, context) => {
    const staffCount = fragment.kind === "pitched" ? fragment.staves.length : 1;
    fragment.bars.forEach((bar, index) => {
      for (const [voice, items] of Object.entries(bar.voices)) {
        const path = ["bars", index, "voices", voice];
        if (!isVoiceKey(voice, staffCount)) context.addIssue({ code: "custom", message: "not a voice of this part", path });
        checkBeats(context, fragment.kind, stringsOf(fragment), items, path);
      }
    });
  })
  .refine(withinSize, `more than ${MAX_FRAGMENT_BYTES} bytes of JSON`);
export type BarsFragment = z.infer<typeof barsFragmentSchema>;

/** Beats in a row of one voice: its kind, and the tuning of a fretted part (what pasting checks the strings against). */
export const beatsFragmentSchema = z
  .discriminatedUnion("kind", [
    z.object({ ...notOfBeats, kind: z.literal("fretted"), tuning, beats }),
    z.object({ ...notOfBeats, ...none(["tuning"]), kind: z.literal("percussion"), beats }),
    z.object({ ...notOfBeats, ...none(["tuning"]), kind: z.literal("pitched"), beats }),
  ])
  .superRefine((fragment, context) => checkBeats(context, fragment.kind, stringsOf(fragment), fragment.beats, ["beats"]))
  .refine(withinSize, `more than ${MAX_FRAGMENT_BYTES} bytes of JSON`);
export type BeatsFragment = z.infer<typeof beatsFragmentSchema>;

/** What the clipboard may hold: either fragment, told apart by `bars` or `beats`. */
export const fragmentSchema = z.union([barsFragmentSchema, beatsFragmentSchema]);
export type Fragment = z.infer<typeof fragmentSchema>;

/** What a fragment of bars says about the part it is of, of each kind. */
type FragmentPart = BarsFragment extends infer Each ? (Each extends unknown ? Omit<Each, "bars"> : never) : never;

/** The fields of a fragment that say what part it is of: only those its kind has. */
function partFields(part: Pick<PartJSON, "kind" | "tuning" | "staves">): FragmentPart {
  if (part.kind === "fretted") return { kind: "fretted", tuning: [...part.tuning] };
  if (part.kind === "pitched") return { kind: "pitched", staves: part.staves.map((staff) => ({ ...staff })) as Extract<BarsFragment, { kind: "pitched" }>["staves"] };
  return { kind: "percussion" };
}

/** The beat, a copy without its id. */
export function withoutId(beat: BeatJSON): BeatWithoutId {
  const copy: Partial<BeatJSON> = { ...beat };
  delete copy.id;
  return copy as BeatWithoutId;
}

/**
 * The bars of a part from one bar to another (either first; both included), all their voices, as
 * a fragment: what "存成樂句" saves. Undefined when the score has no such part or bar.
 */
export function fragmentOfBars(score: ScoreJSON, range: Pick<Extract<Selection, { kind: "bars" }>, "partId" | "anchorBarId" | "focusBarId">): BarsFragment | undefined {
  const part = score.parts.find((item) => item.id === range.partId);
  const anchor = score.bars.findIndex((bar) => bar.id === range.anchorBarId);
  const focus = score.bars.findIndex((bar) => bar.id === range.focusBarId);
  if (part === undefined || anchor < 0 || focus < 0) return undefined;
  const picked = score.bars.slice(Math.min(anchor, focus), Math.max(anchor, focus) + 1);
  return {
    ...partFields(part),
    bars: picked.map((bar) => ({
      timeSig: { ...bar.timeSig },
      voices: Object.fromEntries(Object.entries(part.content[bar.id] ?? {}).map(([voice, items]) => [voice, items.map(withoutId)])),
    })),
  } as BarsFragment;
}

/**
 * A fragment as a score of a single part, the way the phrase editor edits it: every id made
 * anew, in the form docToJson gives (each staff's first voice always there, its second only when
 * it has beats). The bars carry their time signatures only; the part has no name and the
 * program of its kind.
 */
export function fragmentToScore(fragment: BarsFragment): ScoreJSON {
  const kind: PartKind = fragment.kind;
  const partStaves = fragment.kind === "pitched" ? fragment.staves : KIND_DEFAULTS[kind].staves;
  const barIds = fragment.bars.map(() => newId());
  const content = Object.fromEntries(
    fragment.bars.map((bar, index) => [
      barIds[index]!,
      Object.fromEntries(
        voiceKeys(partStaves.length)
          .map((voice): [string, BeatJSON[]] => [voice, (bar.voices[voice] ?? []).map((beat) => ({ ...beat, id: newId() }))])
          .filter(([voice, items]) => items.length > 0 || voice.endsWith(":0")),
      ),
    ]),
  );
  const part = {
    id: newId(),
    name: "",
    kind,
    tuning: fragment.kind === "fretted" ? [...fragment.tuning] : [],
    capo: 0,
    program: KIND_DEFAULTS[kind].program,
    staves: partStaves.map((staff) => ({ ...staff })),
    content,
  } as PartJSON;
  return { schemaVersion: SCHEMA_VERSION, title: "", bars: fragment.bars.map((bar, index) => ({ id: barIds[index]!, timeSig: { ...bar.timeSig } })), parts: [part] };
}

/** The whole of a score of a single part as a fragment: what the phrase editor saves. Throws unless the score has one part and a bar. */
export function scoreToFragment(score: ScoreJSON): BarsFragment {
  const [part] = score.parts;
  const first = score.bars[0];
  const last = score.bars.at(-1);
  if (score.parts.length !== 1 || part === undefined || first === undefined || last === undefined) {
    throw new Error(`a phrase is a score of one part and at least one bar, not ${score.parts.length} parts and ${score.bars.length} bars`);
  }
  return fragmentOfBars(score, { partId: part.id, anchorBarId: first.id, focusBarId: last.id })!;
}

/**
 * A new, blank phrase of a part like this one (docs/spec/phrases.md, section 3): one empty bar
 * of 4/4.
 */
export function blankFragment(part: Pick<PartJSON, "kind" | "tuning" | "staves">): BarsFragment {
  const voices = Object.fromEntries(part.staves.map((_, staff) => [voiceKey(staff, 0), []]));
  return { ...partFields(part), bars: [{ timeSig: { ...COMMON_TIME }, voices }] } as BarsFragment;
}
