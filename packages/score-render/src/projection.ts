// The projection (CONTEXT.md): a score as plain data becomes the model alphaTab draws and plays.
// One way only: nothing built here is ever written back to the score.
import * as alphaTab from "@coderline/alphatab";
import {
  DEFAULT_TEMPO,
  drawnAccidentalOf,
  type BarJSON,
  barTicks,
  beatAfter,
  type BeatJSON,
  type BendType,
  type Harmonic,
  beatTicks,
  DYNAMICS,
  type KeySignature,
  keySigsOf,
  linkReaches,
  linksOn,
  type NoteJSON,
  type NoteValue,
  type PartJSON,
  type ScoreJSON,
  type SlideIn,
  type SlideOut,
  slideGoesOn,
  type Staff,
  WHOLE,
} from "@studio/score-model";

import { channelsOf, type PartChannels } from "./channels";

type AtScore = alphaTab.model.Score;
type AtTrack = alphaTab.model.Track;
type AtStaff = alphaTab.model.Staff;
type AtBar = alphaTab.model.Bar;
type AtBeat = alphaTab.model.Beat;
type AtNote = alphaTab.model.Note;
type AtDynamic = alphaTab.model.DynamicValue;

const { model } = alphaTab;

const NOTE_VALUES: readonly NoteValue[] = [1, 2, 4, 8, 16, 32, 64];

/** Where a beat of the score sits in the alphaTab model, by index. */
export interface BeatAddress {
  track: number;
  staff: number;
  bar: number;
  voice: number;
  beat: number;
}

export interface Projection {
  score: AtScore;
  /** Bar ids in score order: the index is the index of the alphaTab master bar. */
  barIds: string[];
  barIndex: Map<string, number>;
  /** Part ids in score order: the index is the index of the alphaTab track. */
  partIds: string[];
  partIndex: Map<string, number>;
  /** Beat id to its place in the model. Rests added to fill a bar have no id and are not here. */
  addresses: Map<string, BeatAddress>;
  /** `track:staff:bar:voice` to the ids of the beats of that voice, in order. */
  voiceBeatIds: Map<string, string[]>;
}

export function voiceKey(track: number, staff: number, bar: number, voice: number): string {
  return `${track}:${staff}:${bar}:${voice}`;
}

/** The alphaTab beat of a beat of the score, or null when it is not in the projection. */
export function beatOf(projection: Projection, beatId: string): AtBeat | null {
  const at = projection.addresses.get(beatId);
  if (at === undefined) return null;
  return projection.score.tracks[at.track]?.staves[at.staff]?.bars[at.bar]?.voices[at.voice]?.beats[at.beat] ?? null;
}

/** The id of the beat of the score an alphaTab beat stands for; null for a rest added to fill a bar. */
export function beatIdOf(projection: Projection, beat: AtBeat): string | null {
  const bar = beat.voice.bar;
  const ids = projection.voiceBeatIds.get(voiceKey(bar.staff.track.index, bar.staff.index, bar.index, beat.voice.index));
  return ids?.[beat.index] ?? null;
}

/** "0:1" is the second voice of the first staff. */
function parseVoice(key: string): { staff: number; voice: number } {
  const [staff, voice] = key.split(":").map(Number);
  return { staff: staff ?? 0, voice: voice ?? 0 };
}

/**
 * How many voices each staff of a part needs: the most any of its bars uses, at least one. A part
 * has the staves its `staves` say (docs/spec/schema.md, section 4), whatever is written on them.
 */
function staffVoiceCounts(part: PartJSON): number[] {
  const counts = part.staves.map(() => 1);
  for (const voices of Object.values(part.content)) {
    for (const key of Object.keys(voices)) {
      const { staff, voice } = parseVoice(key);
      // A voice of a staff the part has not: the reading left it out already (schema.md, section 5).
      if (staff >= counts.length) continue;
      counts[staff] = Math.max(counts[staff] as number, voice + 1);
    }
  }
  return counts;
}

/**
 * Each clef of the score as alphaTab's clef and octave mark. Tablature has none drawn: G2 as
 * alphaTab's own. A treble clef an octave down draws its notes an octave over where they sound
 * (alphaTab's `Ottavia._8vb` on the bar), as a guitar's or a tenor's.
 */
const CLEFS: Record<Staff["clef"], { clef: alphaTab.model.Clef; ottava: alphaTab.model.Ottavia }> = {
  tab: { clef: model.Clef.G2, ottava: model.Ottavia.Regular },
  neutral: { clef: model.Clef.Neutral, ottava: model.Ottavia.Regular },
  treble: { clef: model.Clef.G2, ottava: model.Ottavia.Regular },
  bass: { clef: model.Clef.F4, ottava: model.Ottavia.Regular },
  "treble-8vb": { clef: model.Clef.G2, ottava: model.Ottavia._8vb },
};

/** The clef of a staff of a part, as its `staves` say: the staff is one of them (`staffVoiceCounts`). */
function clefOf(part: PartJSON, staff: number): (typeof CLEFS)[Staff["clef"]] {
  return CLEFS[(part.staves[staff] as Staff).clef];
}

/**
 * Rests that fill a voice from `from` to `to` (ticks from the start of the bar), longest first
 * at each position that a rest of that length may start on. Stops where no plain rest fits
 * (inside an unfinished tuplet).
 */
export function restsFilling(from: number, to: number): NoteValue[] {
  const rests: NoteValue[] = [];
  let at = from;
  while (to - at >= WHOLE / 64) {
    const value = NOTE_VALUES.find((item) => at % (WHOLE / item) === 0 && at + WHOLE / item <= to);
    if (value === undefined) break;
    rests.push(value);
    at += WHOLE / value;
  }
  return rests;
}

/** The mode that draws each accidental `drawnAccidentalOf` asks for; none asked, alphaTab's own. */
const ACCIDENTAL_MODES: Record<number, alphaTab.model.NoteAccidentalMode> = {
  [-2]: model.NoteAccidentalMode.ForceDoubleFlat,
  [-1]: model.NoteAccidentalMode.ForceFlat,
  0: model.NoteAccidentalMode.ForceNatural,
  1: model.NoteAccidentalMode.ForceSharp,
  2: model.NoteAccidentalMode.ForceDoubleSharp,
};

/**
 * How alphaTab is to spell a pitched note so that it is drawn where the editor finds it
 * (score-model's `lineOfPitch`, docs/spec/schema.md 8.1, #48): as its own spelling when that names
 * its pitch, a natural forced too, else a white key natural, which alphaTab left to itself spells
 * E♯ or C♭ in a key of six or seven sharps or flats; a black key without a spelling of its own as
 * the key has it (`Default`).
 */
function accidentalModeOf(spell: string | undefined, pitch: number): alphaTab.model.NoteAccidentalMode {
  const accidental = drawnAccidentalOf(pitch, spell);
  return accidental === undefined ? model.NoteAccidentalMode.Default : (ACCIDENTAL_MODES[accidental] ?? model.NoteAccidentalMode.Default);
}

const SLIDE_OUT_TYPES: Record<SlideOut, alphaTab.model.SlideOutType> = {
  legato: model.SlideOutType.Legato,
  shift: model.SlideOutType.Shift,
  outUp: model.SlideOutType.OutUp,
  outDown: model.SlideOutType.OutDown,
};

const SLIDE_IN_TYPES: Record<SlideIn, alphaTab.model.SlideInType> = {
  inBelow: model.SlideInType.IntoFromBelow,
  inAbove: model.SlideInType.IntoFromAbove,
};

/**
 * Each preset bend (docs/spec/schema.md, section 8): its alphaTab type and the shape of its bend
 * points, offsets on alphaTab's 0 to 60 across the note, and how far up each point is as a share
 * of the bend (1 the semitones set). Drawn, alphaTab reads only the first two points (and the
 * last of a bend and release, which has four), so each has as many as that.
 */
const BENDS: Record<BendType, { type: alphaTab.model.BendType; shape: [offset: number, share: 0 | 1][] }> = {
  // Up in the first quarter of the note, then held.
  bend: { type: model.BendType.Bend, shape: [[0, 0], [15, 1]] },
  // Up in the first quarter, held, and down again in the last.
  bendRelease: { type: model.BendType.BendRelease, shape: [[0, 0], [15, 1], [45, 1], [60, 0]] },
  // Bent before it is struck, and held.
  preBend: { type: model.BendType.Prebend, shape: [[0, 1], [60, 1]] },
  // Bent before it is struck, and let down in the first quarter.
  preBendRelease: { type: model.BendType.PrebendRelease, shape: [[0, 1], [15, 0]] },
};

/** The harmonic value of a pinch or artificial harmonic: an octave over the fretted note. */
const HARMONIC_OCTAVE = 12;

/**
 * Each harmonic (docs/spec/schema.md, section 8) as alphaTab's type, and the harmonic value it is
 * given: where on the string, in frets, the harmonic is touched. alphaTab sounds a natural
 * harmonic at the node of that fret over the open string (12 an octave, 7 an octave and a fifth,
 * 5 two octaves; a fret with no node in its table, the open string) and draws that value as the
 * fret, so a natural harmonic is given its own fret. Pinch and artificial sound that far over the
 * fretted note: 12, an octave, as alphaTab's Guitar Pro import does; with none they would sound
 * as the note plain.
 */
const HARMONIC_TYPES: Record<Harmonic, { type: alphaTab.model.HarmonicType; value: (fret: number) => number }> = {
  natural: { type: model.HarmonicType.Natural, value: (fret) => fret },
  pinch: { type: model.HarmonicType.Pinch, value: () => HARMONIC_OCTAVE },
  artificial: { type: model.HarmonicType.Artificial, value: () => HARMONIC_OCTAVE },
};

/** Set a bend on an alphaTab note: its type, and its points up `semitones`, in alphaTab's quarter tones. */
function projectBend(note: AtNote, { type, semitones }: NonNullable<NoteJSON["bend"]>): void {
  const bend = BENDS[type];
  for (const [offset, share] of bend.shape) note.addBendPoint(new model.BendPoint(offset, share * semitones * 2));
  // Set after the points: a note given points with no type yet takes them as a custom bend.
  note.bendType = bend.type;
}

/**
 * A note of the score as an alphaTab note, or null when its key does not fit the part.
 * Keys: "s3" is string 3 (1 is the highest), "p38" a drum piece (the alphaTab percussion
 * articulation id, see drums.ts), "n61" a MIDI pitch. A link (legato, a slide out legato or
 * shift) is projected only when `after`, the beat after the note's, holds a note on its string,
 * the note it goes on to: alphaTab would look on past rests and draw it to a later note, where
 * the score has a dangling link (docs/spec/flags.md).
 */
function projectNote(part: PartJSON, key: string, json: NoteJSON, after: BeatJSON | undefined): AtNote | null {
  const number = Number(key.slice(1));
  if (!Number.isInteger(number)) return null;
  const note = new model.Note();
  if (key.startsWith("s") && part.kind === "fretted") {
    // A dead note may have no fret (docs/spec/schema.md, section 8): it is drawn as an X all the same.
    if (number < 1 || number > part.tuning.length || (json.fret === undefined && !json.dead)) return null;
    // alphaTab counts strings from the lowest; the score from the highest.
    note.string = part.tuning.length - number + 1;
    note.fret = json.fret ?? 0;
  } else if (key.startsWith("p") && part.kind === "percussion") {
    note.percussionArticulation = number;
  } else if (key.startsWith("n") && part.kind === "pitched") {
    note.octave = Math.floor(number / 12);
    note.tone = number % 12;
    note.accidentalMode = accidentalModeOf(json.spell, number);
  } else {
    return null;
  }
  if (json.tie) note.isTieDestination = true;
  if (json.dead) note.isDead = true;
  if (json.ghost) note.isGhost = true;
  if (json.staccato) note.isStaccato = true;
  if (json.accent) note.accentuated = model.AccentuationType.Normal;
  if (json.letRing) note.isLetRing = true;
  if (json.palmMute) note.isPalmMute = true;
  if (json.vibrato) note.vibrato = model.VibratoType.Slight;
  const reaches = linkReaches(key, after);
  if (json.legato && reaches) note.isHammerPullOrigin = true;
  // A slide out up or down goes on to no note: it needs none after it.
  if (json.slideOut && (reaches || !slideGoesOn(json.slideOut))) note.slideOutType = SLIDE_OUT_TYPES[json.slideOut];
  if (json.slideIn) note.slideInType = SLIDE_IN_TYPES[json.slideIn];
  if (json.bend) projectBend(note, json.bend);
  if (json.harmonic) {
    const harmonic = HARMONIC_TYPES[json.harmonic];
    note.harmonicType = harmonic.type;
    note.harmonicValue = harmonic.value(note.fret);
  }
  return note;
}

/**
 * How long a strummed beat takes to strum, in ticks (960 a quarter), from its first string to its
 * last: a 64th note, some 30 ms at 120 beats a minute, and no more than a quarter of a short beat.
 * Without it alphaTab sounds every string at once. How it sounds is for the owner to judge by ear
 * (docs/spec/testing.md, section 6).
 */
export const STROKE_TICKS = 60;

const BRUSH_TYPES = { down: model.BrushType.BrushDown, up: model.BrushType.BrushUp } as const;

const DYNAMIC_VALUES: Record<(typeof DYNAMICS)[number], AtDynamic> = {
  pp: model.DynamicValue.PP,
  p: model.DynamicValue.P,
  mp: model.DynamicValue.MP,
  mf: model.DynamicValue.MF,
  f: model.DynamicValue.F,
  ff: model.DynamicValue.FF,
};

/** The dynamic of a voice before any is written: alphaTab's own, f. */
const START_DYNAMIC = model.DynamicValue.F;

/**
 * The dynamic each voice of a projected bar leaves in force, for the bar after it (none: the
 * start of the score).
 */
function dynamicsLeaving(bar: AtBar | null | undefined, voiceCount: number): AtDynamic[] {
  return Array.from({ length: voiceCount }, (_, voice) => bar?.voices[voice]?.beats.at(-1)?.dynamics ?? START_DYNAMIC);
}

/**
 * By projected bar, for each of its voices: whether a dynamic written on a rest is still to be
 * drawn where the bar ends, on the next beat of that voice that is not a rest (#97).
 */
const undrawnLeaving = new WeakMap<AtBar, boolean[]>();

/** Whether each voice of a projected bar leaves a dynamic to draw, for the bar after it (none: the start of the score). */
function dynamicsUndrawn(bar: AtBar | null | undefined, voiceCount: number): boolean[] {
  const undrawn = bar ? undrawnLeaving.get(bar) : undefined;
  return Array.from({ length: voiceCount }, (_, voice) => undrawn?.[voice] ?? false);
}

function rest(value: NoteValue, dynamic: AtDynamic): AtBeat {
  const beat = new model.Beat();
  beat.duration = value as alphaTab.model.Duration;
  beat.dynamics = dynamic;
  return beat;
}

/**
 * A beat of the score, at `dynamic`: the one in force in its voice where it starts, its own when
 * it has one; drawn on it only when it has one. `after` is the beat after it, where its links go.
 */
function projectBeat(part: PartJSON, json: BeatJSON, after: BeatJSON | undefined, dynamic: AtDynamic): AtBeat {
  const beat = rest(json.value, dynamic);
  // A dynamic is drawn where it is written only: alphaTab would draw one where the dynamic in force
  // changes, and its own f on the first note of a voice that has none (`shouldCreateDynamicsGlyph`).
  // One written on a rest, which alphaTab never draws, is drawn on a later beat (`projectBar`).
  beat.showDynamics = json.dynamic !== undefined;
  beat.dots = json.dots;
  if (json.tuplet) {
    beat.tupletNumerator = json.tuplet.actual;
    beat.tupletDenominator = json.tuplet.normal;
  }
  if (json.stroke) {
    beat.brushType = BRUSH_TYPES[json.stroke];
    beat.brushDuration = Math.min(STROKE_TICKS, beatTicks(json) / 4);
  }
  if (json.slap) beat.slap = true;
  if (json.pop) beat.pop = true;
  if (json.text) beat.text = json.text;
  for (const [key, noteJson] of Object.entries(json.notes)) {
    const note = projectNote(part, key, noteJson, after);
    if (!note) continue;
    beat.addNote(note);
    // Tapping is the beat's in alphaTab: any note of the beat tapped taps it.
    if (noteJson.tap) beat.tap = true;
  }
  return beat;
}

/** Where a bar sits in the score: what it takes from the bars around it. */
interface BarPlace {
  /** The bar after it, where the links of its last beats go (none for the last). */
  next: BarJSON | undefined;
  /** The key in force in it (docs/spec/schema.md, section 3). */
  key: KeySignature;
  /**
   * How long a pickup bar is, in ticks: what its voices are filled to with rests; null for a
   * full bar, filled to its time signature.
   */
  pickup: number | null;
}

const KEY_SIGNATURE_TYPES = { major: model.KeySignatureType.Major, minor: model.KeySignatureType.Minor } as const;

/**
 * One bar of one staff of a part, with every voice the staff has. A dynamic holds from its beat
 * on, in its voice (docs/spec/schema.md, section 8): each voice starts at the dynamic in force at
 * the end of the same voice in `previous`, the bar before (none for the first). A dynamic written
 * on a rest is drawn on the next beat of its voice that is not a rest, in this bar or a later one,
 * unless one is written on that beat or a rest before it: alphaTab draws none on a rest (#97).
 * Returns the ids of its beats by voice.
 */
function projectBar(part: PartJSON, bar: BarJSON, { next, key: keySig, pickup }: BarPlace, staff: number, voiceCount: number, previous: AtBar | undefined): { bar: AtBar; beatIds: string[][] } {
  const entering = dynamicsLeaving(previous, voiceCount);
  const undrawnEntering = dynamicsUndrawn(previous, voiceCount);
  const undrawnLeavingBar: boolean[] = [];
  const atBar = new model.Bar();
  const { clef, ottava } = clefOf(part, staff);
  atBar.clef = clef;
  atBar.clefOttava = ottava;
  // A drum staff has no key: it would only draw sharps and flats on it.
  if (part.kind !== "percussion") {
    atBar.keySignature = keySig.fifths as alphaTab.model.KeySignature;
    atBar.keySignatureType = KEY_SIGNATURE_TYPES[keySig.mode];
  }
  const beatIds: string[][] = [];
  const content = part.content[bar.id] ?? {};
  // The dynamics the voices before draw, by tick from the start of the bar.
  const drawnBefore = new Map<number, AtDynamic[]>();
  for (let voice = 0; voice < voiceCount; voice++) {
    const atVoice = new model.Voice();
    atBar.addVoice(atVoice);
    const key = `${staff}:${voice}`;
    const beats = content[key] ?? [];
    const following = next && part.content[next.id]?.[key];
    beatIds.push(beats.map((beat) => beat.id));
    // The rests that fill a voice carry its dynamic too: the bar after reads it off its last beat.
    let dynamic = entering[voice];
    // Whether a dynamic is written that no beat has been drawn with yet: the beat that draws it
    // draws the one in force there, the last written.
    let undrawn = undrawnEntering[voice] as boolean;
    const drawnHere: [number, AtDynamic][] = [];
    let tick = 0;
    for (const [index, beat] of beats.entries()) {
      if (beat.dynamic) dynamic = DYNAMIC_VALUES[beat.dynamic];
      const atBeat = projectBeat(part, beat, beatAfter(beats, index, following), dynamic);
      if (beat.dynamic) undrawn = true;
      if (undrawn && !atBeat.isRest) {
        atBeat.showDynamics = true;
        undrawn = false;
      }
      if (atBeat.showDynamics && !atBeat.isRest) {
        // The same dynamic drawn at the same place by a voice before: once is enough. alphaTab
        // would draw it again, as it skips its own check when `showDynamics` is set (#30, #45).
        if (drawnBefore.get(tick)?.includes(atBeat.dynamics)) atBeat.showDynamics = false;
        else drawnHere.push([tick, atBeat.dynamics]);
      }
      tick += beatTicks(beat);
      atVoice.addBeat(atBeat);
    }
    for (const [at, drawn] of drawnHere) drawnBefore.set(at, [...(drawnBefore.get(at) ?? []), drawn]);
    undrawnLeavingBar.push(undrawn);
    if (beats.length === 0 && (pickup === null || voice > 0)) {
      // An empty first voice is a whole-bar rest; other voices stay invisible, and take no time.
      const filler = rest(1, dynamic);
      filler.isEmpty = voice > 0;
      atVoice.addBeat(filler);
      continue;
    }
    // A voice that does not fill its bar is completed with rests, here only (it stays flagged); in
    // a pickup bar, up to the longest voice of the bar in any part, which alphaTab takes as its length.
    const held = beats.reduce((sum, beat) => sum + beatTicks(beat), 0);
    for (const value of restsFilling(held, pickup ?? barTicks(bar.timeSig))) atVoice.addBeat(rest(value, dynamic));
  }
  undrawnLeaving.set(atBar, undrawnLeavingBar);
  return { bar: atBar, beatIds };
}

/**
 * Where each bar of a score sits: the bar after it, the key in force, and for the first bar when
 * it is a pickup (docs/spec/schema.md, section 3), its length: that of its longest voice in any
 * part, up to its time signature. A pickup bar with nothing in it is as long as its time signature.
 */
function placesOf(json: ScoreJSON): BarPlace[] {
  const keys = keySigsOf(json.bars);
  return json.bars.map((bar, index) => {
    let pickup: number | null = null;
    if (index === 0 && bar.anacrusis) {
      const full = barTicks(bar.timeSig);
      const held = json.parts.flatMap((part) => Object.values(part.content[bar.id] ?? {}).map((beats) => beats.reduce((sum, beat) => sum + beatTicks(beat), 0)));
      const longest = Math.max(0, ...held);
      pickup = longest > 0 ? Math.min(longest, full) : full;
    }
    return { next: json.bars[index + 1], key: keys[index] as KeySignature, pickup };
  });
}

function projectTrack(part: PartJSON, channels: PartChannels): AtTrack {
  const track = new model.Track();
  track.name = part.name;
  track.shortName = part.name;
  const info = track.playbackInfo;
  // Drums play program 0 on the percussion channel (docs/spec/playback.md, section 5).
  info.program = part.kind === "percussion" ? 0 : part.program;
  info.primaryChannel = channels.primary;
  info.secondaryChannel = channels.secondary;
  return track;
}

function setUpStaff(staff: AtStaff, part: PartJSON): void {
  staff.capo = part.capo;
  staff.displayTranspositionPitch = 0;
  if (part.kind === "fretted") {
    staff.stringTuning.tunings = [...part.tuning];
    staff.showTablature = true;
    staff.showStandardNotation = false;
  } else {
    staff.stringTuning.tunings = [];
    staff.showTablature = false;
    staff.showStandardNotation = true;
    staff.isPercussion = part.kind === "percussion";
  }
}

function recordBeatIds(projection: Projection, track: number, staff: number, bar: number, beatIds: string[][]): void {
  beatIds.forEach((ids, voice) => {
    projection.voiceBeatIds.set(voiceKey(track, staff, bar, voice), ids);
    ids.forEach((id, beat) => projection.addresses.set(id, { track, staff, bar, voice, beat }));
  });
}

export interface ProjectionTimings {
  /** Building the model, in milliseconds. */
  build: number;
  /** alphaTab's `finish()` over it, in milliseconds. */
  finish: number;
}

/** Build the whole alphaTab model of a score. */
export function projectScore(json: ScoreJSON, settings: alphaTab.Settings, timings?: ProjectionTimings): Projection {
  const started = performance.now();
  const score = new model.Score();
  score.title = json.title;
  // The tuning of each fretted part is written beside its own tablature on the first system, not
  // as one list above the score, where those of several parts were drawn over each other
  // (docs/spike-report.md, 其他意外).
  score.stylesheet.tuningDisplayMode = model.TuningDisplayMode.Staff;
  const projection: Projection = {
    score,
    barIds: json.bars.map((bar) => bar.id),
    barIndex: new Map(json.bars.map((bar, index) => [bar.id, index])),
    partIds: json.parts.map((part) => part.id),
    partIndex: new Map(json.parts.map((part, index) => [part.id, index])),
    addresses: new Map(),
    voiceBeatIds: new Map(),
  };

  const places = placesOf(json);
  json.bars.forEach((bar, index) => {
    const masterBar = new model.MasterBar();
    masterBar.timeSignatureNumerator = bar.timeSig.numerator;
    masterBar.timeSignatureDenominator = bar.timeSig.denominator;
    const tempo = bar.tempo ?? (index === 0 ? DEFAULT_TEMPO : undefined);
    if (tempo !== undefined) masterBar.tempoAutomations.push(model.Automation.buildTempoAutomation(false, 0, tempo, 2));
    if (bar.repeatStart) masterBar.isRepeatStart = true;
    if (bar.repeatEnd !== undefined) masterBar.repeatCount = bar.repeatEnd;
    // One bit a pass, the first pass the lowest bit.
    for (const pass of bar.voltas ?? []) masterBar.alternateEndings |= 1 << (pass - 1);
    if (bar.section !== undefined) {
      masterBar.section = new model.Section();
      masterBar.section.text = bar.section;
    }
    masterBar.isAnacrusis = places[index]?.pickup !== null;
    score.addMasterBar(masterBar);
  });

  const channels = channelsOf(json.parts.map((part) => part.kind));
  json.parts.forEach((part, trackIndex) => {
    const track = projectTrack(part, channels[trackIndex] as PartChannels);
    const voiceCounts = staffVoiceCounts(part);
    track.ensureStaveCount(voiceCounts.length);
    score.addTrack(track);
    track.staves.forEach((staff, staffIndex) => {
      setUpStaff(staff, part);
      const voiceCount = voiceCounts[staffIndex] as number;
      json.bars.forEach((bar, barIndex) => {
        const built = projectBar(part, bar, places[barIndex] as BarPlace, staffIndex, voiceCount, staff.bars[barIndex - 1]);
        staff.addBar(built.bar);
        recordBeatIds(projection, trackIndex, staffIndex, barIndex, built.beatIds);
      });
    });
  });

  const built = performance.now();
  score.finish(settings);
  if (timings) {
    timings.build = built - started;
    timings.finish = performance.now() - built;
  }
  return projection;
}

/** Notes of the bar after a replaced one that continue a note of the old bar: tie them to the new one. */
function retie(next: AtBar | null, replaced: AtBar): void {
  if (next === null) return;
  for (const voice of next.voices) {
    for (const beat of voice.beats) {
      for (const note of beat.notes) {
        if (!note.isTieDestination || note.tieOrigin?.beat.voice.bar !== replaced) continue;
        const origin = model.Note.findTieOrigin(note);
        note.tieOrigin = origin;
        if (origin) origin.tieDestination = note;
      }
    }
  }
}

/**
 * Whether a note of a bar of the model goes on, by a link, to a note of another bar: a link across
 * a bar line. Only the last beat of a voice can: a link is projected only to the beat just after.
 */
function modelLinksOutOf(bar: AtBar | undefined): boolean {
  const leaves = (target: AtNote | null) => target !== null && target.beat.voice.bar !== bar;
  return bar?.voices.some((voice) => voice.beats.at(-1)?.notes.some((note) => leaves(note.hammerPullDestination) || leaves(note.slideTarget))) ?? false;
}

/** Whether a note of the bar at `index` of the score goes on, by a link, to the first beat of the bar after it. */
function scoreLinksOutOf(json: ScoreJSON, index: number): boolean {
  const bar = json.bars[index];
  const next = json.bars[index + 1];
  if (bar === undefined || next === undefined) return false;
  return json.parts.some((part) =>
    Object.entries(part.content[bar.id] ?? {}).some(([voice, beats]) => {
      const after = beatAfter(beats, beats.length - 1, part.content[next.id]?.[voice]);
      return Object.entries(beats.at(-1)?.notes ?? {}).some(([key, note]) => linksOn(note) && linkReaches(key, after));
    }),
  );
}

/**
 * Rebuild the bars named by `barIds` inside an existing projection, leaving every other bar of
 * the alphaTab model as it is (same objects). A bar that leaves another dynamic in force than it
 * did, or another dynamic written on a rest still to draw (#97), has the bar after it rebuilt too,
 * and so on up to a bar whose voices go on as before: the next written dynamic in each voice that
 * changed, or, for one still to draw, the next beat that is not a rest, past any bars of rests
 * only in between. A bar line that a link crosses, before the
 * change or after it, has the bars on both sides of it rebuilt: both notes of a link hold it, and
 * alphaTab sets it up when it finishes the bar of the note it starts from. Returns the index of
 * the first rebuilt bar, or null when the change is not one this can do (a bar, a part or a voice
 * count changed, or the length of a pickup bar): the caller then projects the whole score again.
 */
export function replaceBars(projection: Projection, json: ScoreJSON, barIds: readonly string[], settings: alphaTab.Settings, timings?: ProjectionTimings): number | null {
  const started = performance.now();
  if (json.bars.length !== projection.barIds.length || json.parts.length !== projection.partIds.length) return null;
  const indexes = barIds.map((id) => projection.barIndex.get(id));
  if (indexes.some((index) => index === undefined)) return null;
  const places = placesOf(json);
  // A pickup bar is as long as its longest voice, and every bar after it starts where it ends:
  // alphaTab works those out only when the whole score is finished. While its length stays (a
  // change in a voice shorter than the longest), its bars are replaced like any other; the model
  // still has the old bars here, so the master bar measures the old length.
  const pickup = places[0]?.pickup ?? null;
  if (pickup !== null && pickup !== projection.score.masterBars[0]?.calculateDuration()) return null;
  const voiceCounts = json.parts.map(staffVoiceCounts);
  const tracks = projection.score.tracks;
  const sameShape = json.parts.every((part, trackIndex) => {
    const track = tracks[trackIndex];
    const counts = voiceCounts[trackIndex] as number[];
    return (
      projection.partIds[trackIndex] === part.id &&
      track?.staves.length === counts.length &&
      track.staves.every((staff, staffIndex) => staff.bars[0]?.voices.length === counts[staffIndex])
    );
  });
  if (!sameShape) return null;

  /**
   * Whether a link crosses the line after bar `index`: in the score, or in the model, read before
   * that bar is replaced. Kept by index: each is asked first before its bar is replaced.
   */
  const crossings = new Map<number, boolean>();
  const crossed = (index: number) => {
    let crosses = crossings.get(index);
    if (crosses === undefined) {
      crosses = scoreLinksOutOf(json, index) || tracks.some((track) => track.staves.some((staff) => modelLinksOutOf(staff.bars[index])));
      crossings.set(index, crosses);
    }
    return crosses;
  };
  const rebuilt = new Set(indexes as number[]);
  // The bars before the ones to rebuild that a link reaches them from, and the bars before those;
  // the bars after are seen to below, as each is rebuilt.
  for (const index of [...rebuilt]) {
    for (let line = index - 1; line >= 0 && !rebuilt.has(line) && crossed(line); line--) rebuilt.add(line);
  }

  // Every bar is built and put in its place first, then each is finished, in order: finishing a
  // bar sets up the links from its notes to the bar after, which must be the new one by then.
  // Each bar replaced, with the bar it took the place of, to retie the bar after.
  const replaced: { old: AtBar; atBar: AtBar }[] = [];
  const first = Math.min(...rebuilt);
  for (let barIndex = first; barIndex < json.bars.length; barIndex++) {
    if (!rebuilt.has(barIndex)) continue;
    if (crossed(barIndex)) rebuilt.add(barIndex + 1);
    const bar = json.bars[barIndex] as BarJSON;
    json.parts.forEach((part, trackIndex) => {
      const track = tracks[trackIndex] as AtTrack;
      track.staves.forEach((staff, staffIndex) => {
        const old = staff.bars[barIndex] as AtBar;
        // Drop the ids of the old beats before the new ones take their place.
        old.voices.forEach((_, voice) => {
          for (const id of projection.voiceBeatIds.get(voiceKey(trackIndex, staffIndex, barIndex, voice)) ?? []) projection.addresses.delete(id);
        });
        const voiceCount = (voiceCounts[trackIndex] as number[])[staffIndex] as number;
        const built = projectBar(part, bar, places[barIndex] as BarPlace, staffIndex, voiceCount, staff.bars[barIndex - 1]);
        const atBar = built.bar;
        atBar.staff = staff;
        atBar.index = barIndex;
        atBar.previousBar = old.previousBar;
        atBar.nextBar = old.nextBar;
        if (old.previousBar) old.previousBar.nextBar = atBar;
        if (old.nextBar) old.nextBar.previousBar = atBar;
        staff.bars[barIndex] = atBar;
        recordBeatIds(projection, trackIndex, staffIndex, barIndex, built.beatIds);
        replaced.push({ old, atBar });
        // The bar after starts at the dynamic this one leaves, and draws one this one leaves undrawn:
        // when either changed, it is rebuilt as well.
        const before = dynamicsLeaving(old, voiceCount);
        const undrawnBefore = dynamicsUndrawn(old, voiceCount);
        const undrawnAfter = dynamicsUndrawn(atBar, voiceCount);
        if (dynamicsLeaving(atBar, voiceCount).some((dynamic, voice) => dynamic !== before[voice] || undrawnAfter[voice] !== undrawnBefore[voice])) rebuilt.add(barIndex + 1);
      });
    });
  }

  let finishing = 0;
  for (const { old, atBar } of replaced) {
    // The last beat of the bar before leads into this one.
    atBar.previousBar?.voices.forEach((voice, voiceIndex) => {
      const last = voice.beats.at(-1);
      const first = atBar.voices[voiceIndex]?.beats[0];
      if (last && first) {
        last.nextBeat = first;
        first.previousBeat = last;
      }
    });
    const finishStarted = performance.now();
    atBar.finish(settings, new Map());
    finishing += performance.now() - finishStarted;
    retie(atBar.nextBar, old);
  }
  if (timings) {
    timings.finish = finishing;
    timings.build = performance.now() - started - finishing;
  }
  return first;
}
