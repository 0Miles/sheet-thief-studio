// Legal scores as plain data, written from docs/spec/schema.md rather than from the zod schema,
// so that the schema is checked against the spec and not against itself. Every score is in the
// form docToJson gives: every bar in the content of every part, the first voice of each staff
// always there, a second voice only when it holds beats.
import fc from "fast-check";

import { type BarJSON, type BeatJSON, type NoteJSON, type PartJSON, SCHEMA_VERSION, type ScoreJSON } from "../src/index";

const id = fc.string({ minLength: 1, maxLength: 10 });
const midi = fc.integer({ min: 0, max: 127 });
const yes = fc.constant(true as const);
/** Characters of one or two UTF-16 code units: ASCII, CJK, a letter with a combining accent, an emoji. */
const unit = fc.oneof({ weight: 6, arbitrary: fc.string({ minLength: 1, maxLength: 1 }) }, { weight: 1, arbitrary: fc.constantFrom("譜", "é", "😀") });

/** From `min` to `max` UTF-16 code units: ASCII up to the limit, or any text within it. */
const text = (min: number, max: number) =>
  fc.oneof(
    fc.string({ minLength: min, maxLength: max }),
    fc.string({ unit, minLength: min, maxLength: max }).filter((value) => value.length >= min && value.length <= max),
  );

const timeSig = fc.record({ numerator: fc.integer({ min: 1, max: 32 }), denominator: fc.constantFrom(1, 2, 4, 8, 16, 32) });

function bar(first: boolean): fc.Arbitrary<Omit<BarJSON, "id">> {
  return fc.record(
    {
      timeSig,
      tempo: fc.double({ min: 20, max: 400, noNaN: true }),
      keySig: fc.record({ fifths: fc.integer({ min: -7, max: 7 }), mode: fc.constantFrom("major" as const, "minor" as const) }),
      repeatStart: yes,
      repeatEnd: fc.integer({ min: 2, max: 32 }),
      voltas: fc.uniqueArray(fc.integer({ min: 1, max: 8 }), { minLength: 1, maxLength: 8 }).map((items) => items.sort((a, b) => a - b)),
      section: text(1, 64),
      // A pickup bar can only be the first one.
      ...(first ? { anacrusis: yes } : {}),
    },
    { requiredKeys: ["timeSig"] },
  );
}

const frettedNote: fc.Arbitrary<NoteJSON> = fc
  .record(
    {
      fret: fc.integer({ min: 0, max: 36 }),
      dead: yes,
      tie: yes,
      ghost: yes,
      accent: yes,
      staccato: yes,
      legato: yes,
      slideOut: fc.constantFrom("legato" as const, "shift" as const, "outUp" as const, "outDown" as const),
      slideIn: fc.constantFrom("inBelow" as const, "inAbove" as const),
      bend: fc.record({ type: fc.constantFrom("bend" as const, "bendRelease" as const, "preBend" as const, "preBendRelease" as const), semitones: fc.integer({ min: 1, max: 4 }) }),
      vibrato: yes,
      palmMute: yes,
      letRing: yes,
      tap: yes,
      harmonic: fc.constantFrom("natural" as const, "pinch" as const, "artificial" as const),
    },
    { requiredKeys: [] },
  )
  // A fretted note has a fret unless it is dead.
  .filter((note) => note.fret !== undefined || note.dead === true);

const percussionNote: fc.Arbitrary<NoteJSON> = fc.record({ ghost: yes, accent: yes }, { requiredKeys: [] });

const spell = fc.tuple(fc.constantFrom("A", "B", "C", "D", "E", "F", "G"), fc.constantFrom("", "#", "b", "##", "x", "bb")).map(([name, accidental]) => name + accidental);
const pitchedNote: fc.Arbitrary<NoteJSON> = fc.record({ tie: yes, accent: yes, staccato: yes, spell }, { requiredKeys: [] });

/** Notes keyed by position: strings 1 to `strings`, drum pieces and pitches 0 to 127. */
function notes(kind: PartJSON["kind"], strings: number): fc.Arbitrary<Record<string, NoteJSON>> {
  const [key, note] =
    kind === "fretted"
      ? [fc.integer({ min: 1, max: strings }).map((n) => `s${n}`), frettedNote]
      : kind === "percussion"
        ? [midi.map((n) => `p${n}`), percussionNote]
        : [midi.map((n) => `n${n}`), pitchedNote];
  return fc.dictionary(key, note, { maxKeys: 3 });
}

const tuplet = fc
  .record({ actual: fc.integer({ min: 2, max: 12 }), normal: fc.integer({ min: 1, max: 12 }) })
  .filter((item) => item.actual !== item.normal);

function beat(kind: PartJSON["kind"], strings: number): fc.Arbitrary<BeatJSON> {
  const common = {
    id,
    value: fc.constantFrom(1 as const, 2 as const, 4 as const, 8 as const, 16 as const, 32 as const, 64 as const),
    dots: fc.constantFrom(0 as const, 1 as const, 2 as const),
    tuplet,
    notes: notes(kind, strings),
    dynamic: fc.constantFrom("pp" as const, "p" as const, "mp" as const, "mf" as const, "f" as const, "ff" as const),
    text: text(1, 64),
  };
  const requiredKeys: ("id" | "value" | "dots" | "notes")[] = ["id", "value", "dots", "notes"];
  if (kind === "fretted") {
    // Slap and pop never on the same beat.
    const hand = fc.constantFrom({}, { slap: true as const }, { pop: true as const });
    return fc
      .tuple(fc.record({ ...common, stroke: fc.constantFrom("down" as const, "up" as const) }, { requiredKeys }), hand)
      .map(([fields, slapOrPop]) => ({ ...fields, ...slapOrPop }));
  }
  if (kind === "pitched") return fc.record({ ...common, lyric: text(0, 32) }, { requiredKeys });
  return fc.record(common, { requiredKeys });
}

type PartFields = Omit<PartJSON, "id" | "content">;

const fretted: fc.Arbitrary<PartFields> = fc.record({
  name: text(1, 64),
  kind: fc.constant("fretted" as const),
  tuning: fc.array(midi, { minLength: 4, maxLength: 7 }),
  capo: fc.integer({ min: 0, max: 24 }),
  program: midi,
  staves: fc.constant([{ clef: "tab" as const }] as [{ clef: "tab" }]),
});
const percussion: fc.Arbitrary<PartFields> = fc.record({
  name: text(1, 64),
  kind: fc.constant("percussion" as const),
  tuning: fc.constant([] as []),
  capo: fc.constant(0 as const),
  program: fc.constant(0 as const),
  staves: fc.constant([{ clef: "neutral" as const }] as [{ clef: "neutral" }]),
});
const pitched: fc.Arbitrary<PartFields> = fc.record({
  name: text(1, 64),
  kind: fc.constant("pitched" as const),
  tuning: fc.constant([] as []),
  capo: fc.constant(0 as const),
  program: midi,
  staves: fc.array(fc.record({ clef: fc.constantFrom("treble" as const, "bass" as const, "treble-8vb" as const) }), { minLength: 1, maxLength: 2 }),
});

/** The content of one bar of a part: each staff's first voice, and its second one when it has beats. */
function barContent(part: PartFields): fc.Arbitrary<Record<string, BeatJSON[]>> {
  const voice = (minLength: number) => fc.array(beat(part.kind, part.tuning.length), { minLength, maxLength: 3 });
  return fc
    .tuple(...part.staves.map(() => fc.tuple(voice(0), fc.option(voice(1), { nil: undefined }))))
    .map((staves) => Object.fromEntries(staves.flatMap(([first, second], staff) => [[`${staff}:0`, first], ...(second ? [[`${staff}:1`, second]] : [])])));
}

/** A legal score of at most `maxBars` bars and `maxParts` parts, in the form docToJson gives. */
export function score({ maxBars = 3, maxParts = 3 } = {}): fc.Arbitrary<ScoreJSON> {
  return fc
    .record(
      {
        title: text(0, 100),
        artist: text(1, 100),
        // fast-check likes to try __proto__, which no bar may be called.
        barIds: fc.uniqueArray(id.filter((value) => value !== "__proto__"), { maxLength: maxBars }),
        partIds: fc.uniqueArray(id, { maxLength: maxParts }),
      },
      { requiredKeys: ["title", "barIds", "partIds"] },
    )
    .chain(({ barIds, partIds, ...meta }) =>
      fc
        .tuple(
          fc.tuple(...barIds.map((barId, index) => bar(index === 0).map((fields): BarJSON => ({ id: barId, ...fields })))),
          fc.tuple(
            ...partIds.map((partId) =>
              fc
                .oneof(fretted, percussion, pitched)
                .chain((part) => fc.tuple(...barIds.map(() => barContent(part))).map((contents): PartJSON => ({ id: partId, ...part, content: Object.fromEntries(barIds.map((barId, index) => [barId, contents[index]!])) }) as PartJSON)),
            ),
          ),
        )
        .map(([bars, parts]): ScoreJSON => ({ schemaVersion: SCHEMA_VERSION, ...meta, bars, parts })),
    );
}
