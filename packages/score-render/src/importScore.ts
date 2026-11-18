// Import (CONTEXT.md): a Guitar Pro or MusicXML file, read by alphaTab, becomes a new score as plain
// data (docs/spec/import-export.md, section 2). Its own function: the projection stays one way.
// What the score cannot hold is left out and listed in the import report.
import * as alphaTab from "@coderline/alphatab";
import {
  type BarJSON,
  type BeatJSON,
  type BendType,
  DEFAULT_KEY_SIG,
  DEFAULT_TEMPO,
  DYNAMICS,
  type Harmonic,
  importedScoreSchema,
  jsonBytes,
  type KeySignature,
  KIND_DEFAULTS,
  MAX_BARS,
  MAX_BEAT_TEXT,
  MAX_CAPO,
  MAX_FRET,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_FILE_BYTES,
  MAX_LYRIC,
  MAX_NON_PERCUSSION_PARTS,
  MAX_PART_NAME,
  MAX_PARTS,
  MAX_REPEAT,
  MAX_SECTION_NAME,
  MAX_STAVES,
  MAX_TITLE,
  newId,
  NOTE_LETTERS,
  NOTE_VALUES,
  type NoteJSON,
  type NoteValue,
  type PartJSON,
  type PartKind,
  SCHEMA_VERSION,
  type ScoreJSON,
  type SlideIn,
  type SlideOut,
  type Staff,
  STRING_COUNTS,
  TEMPO_RANGE,
  type TimeSignature,
  timeSigSchema,
  tupletSchema,
  voiceKey,
} from "@studio/score-model";

type AtScore = alphaTab.model.Score;
type AtTrack = alphaTab.model.Track;
type AtStaff = alphaTab.model.Staff;
type AtBar = alphaTab.model.Bar;
type AtBeat = alphaTab.model.Beat;
type AtNote = alphaTab.model.Note;

const { model } = alphaTab;

// The largest file read at all (docs/spec/import-export.md, section 2), checked before alphaTab
// reads it: defined in score-model, where the web app's texts read it without loading alphaTab.
export { MAX_IMPORT_FILE_BYTES };

/**
 * What an import leaves out or changes (docs/spec/import-export.md, section 2): each is listed in the
 * import report, with the bars it happens in. The interface says each in its own words.
 */
export const IMPORT_LOSSES = [
  // Text cut to its limit.
  "titleTruncated",
  "artistTruncated",
  "partNameTruncated",
  "sectionTruncated",
  "textTruncated",
  "lyricTruncated",
  // Bars.
  "jump",
  "tempoInBar",
  "tempoText",
  "tempoOutOfRange",
  "timeSignature",
  "swing",
  "fermata",
  "repeatCount",
  // Parts and staves.
  "strings",
  "tablatureHidden",
  "capo",
  "clef",
  "staves",
  "voices",
  "transposition",
  // Beats.
  "duration",
  "dots",
  "tuplet",
  "grace",
  "dynamic",
  "crescendo",
  "lyricLines",
  "lyricOnUnpitched",
  "chord",
  "slashed",
  "ottava",
  "pedal",
  "whammy",
  "tremolo",
  "arpeggio",
  // Notes.
  "fret",
  "pitch",
  "drum",
  "bend",
  "harmonic",
  "slide",
  "trill",
  "fingering",
  "ornament",
  "slur",
  "technique",
] as const;
export type ImportLoss = (typeof IMPORT_LOSSES)[number];

/** One line of the import report: what was left out or changed, how many times, and in which bars (1 is the first; none for the score or a part as a whole). */
export interface ImportReportItem {
  loss: ImportLoss;
  count: number;
  bars: number[];
}

/**
 * Why a file makes no score: alphaTab cannot read it, or it is over a limit (docs/spec/schema.md,
 * section 13), none of it cut to fit. `invalid` is what this function made and the schema refused:
 * a fault here, not in the file.
 */
export type ImportFailure = "fileTooLarge" | "unreadable" | "tooManyParts" | "tooManyNonDrumParts" | "tooManyBars" | "tooLarge" | "invalid";

export type ImportResult = { ok: true; score: ScoreJSON; report: ImportReportItem[] } | { ok: false; failure: ImportFailure };

/** The losses of one import, as they are found. */
class Report {
  private readonly items = new Map<ImportLoss, { count: number; bars: Set<number> }>();

  /** `bar` is the index of the bar it happens in; none for the score or a part as a whole. */
  add(loss: ImportLoss, bar?: number): void {
    let item = this.items.get(loss);
    if (item === undefined) {
      item = { count: 0, bars: new Set() };
      this.items.set(loss, item);
    }
    item.count += 1;
    if (bar !== undefined) item.bars.add(bar + 1);
  }

  /** In the order of `IMPORT_LOSSES`. */
  list(): ImportReportItem[] {
    return IMPORT_LOSSES.flatMap((loss) => {
      const item = this.items.get(loss);
      return item ? [{ loss, count: item.count, bars: [...item.bars].sort((a, b) => a - b) }] : [];
    });
  }
}

/** Cut a text to `max` characters, reporting it when it was longer. */
function cut(value: string, max: number, report: Report, loss: ImportLoss, bar?: number): string {
  if (value.length <= max) return value;
  report.add(loss, bar);
  return value.slice(0, max);
}

/** The kind of a part, from its first staff (docs/spec/import-export.md, 2.1). */
function kindOf(staff: AtStaff | undefined): PartKind {
  if (staff === undefined) return "pitched";
  if (staff.isPercussion) return "percussion";
  // alphaTab gives a staff written as notes only a guitar's tuning when it reads Guitar Pro 6 to 8
  // (to finger it), and Guitar Pro 3 to 5 give every track strings: tablature shown tells a fretted part.
  return staff.stringTuning.tunings.length > 0 && staff.showTablature ? "fretted" : "pitched";
}

/** The General MIDI programs of guitars and basses, from 0. */
const STRINGED_PROGRAMS: readonly number[] = Array.from({ length: 16 }, (_, index) => 24 + index);

/** The kinds of the parts a score's tracks become, a fretted one of a string count the score cannot hold read as pitched. */
function kindsOf(score: AtScore): PartKind[] {
  return score.tracks.map((track) => {
    const kind = kindOf(track.staves[0]);
    const strings = track.staves[0]?.stringTuning.tunings.length ?? 0;
    return kind === "fretted" && (strings < STRING_COUNTS.min || strings > STRING_COUNTS.max) ? "pitched" : kind;
  });
}

/** The 1-based note value of an alphaTab duration, when the score has it. */
function noteValueOf(duration: alphaTab.model.Duration): NoteValue | undefined {
  return NOTE_VALUES.find((value) => value === (duration as number));
}

const DYNAMIC_NAMES: Partial<Record<alphaTab.model.DynamicValue, (typeof DYNAMICS)[number]>> = {
  [model.DynamicValue.PPP]: "pp",
  [model.DynamicValue.PP]: "pp",
  [model.DynamicValue.P]: "p",
  [model.DynamicValue.MP]: "mp",
  [model.DynamicValue.MF]: "mf",
  [model.DynamicValue.F]: "f",
  [model.DynamicValue.FF]: "ff",
  [model.DynamicValue.FFF]: "ff",
};

/** Softer or louder than the score has: as its softest or loudest, and reported. */
const DYNAMIC_NEAREST: Partial<Record<alphaTab.model.DynamicValue, (typeof DYNAMICS)[number]>> = {
  [model.DynamicValue.PPPP]: "pp",
  [model.DynamicValue.PPPPP]: "pp",
  [model.DynamicValue.PPPPPP]: "pp",
  [model.DynamicValue.FFFF]: "ff",
  [model.DynamicValue.FFFFF]: "ff",
  [model.DynamicValue.FFFFFF]: "ff",
};

/** The dynamic of a voice before any is written: alphaTab's own, f (as the projection's). */
const START_DYNAMIC = "f";

const SLIDE_OUTS: Partial<Record<alphaTab.model.SlideOutType, SlideOut>> = {
  [model.SlideOutType.Legato]: "legato",
  [model.SlideOutType.Shift]: "shift",
  [model.SlideOutType.OutUp]: "outUp",
  [model.SlideOutType.OutDown]: "outDown",
};

const SLIDE_INS: Partial<Record<alphaTab.model.SlideInType, SlideIn>> = {
  [model.SlideInType.IntoFromBelow]: "inBelow",
  [model.SlideInType.IntoFromAbove]: "inAbove",
};

const HARMONICS: Partial<Record<alphaTab.model.HarmonicType, Harmonic>> = {
  [model.HarmonicType.Natural]: "natural",
  [model.HarmonicType.Pinch]: "pinch",
  [model.HarmonicType.Artificial]: "artificial",
};

const BENDS: Partial<Record<alphaTab.model.BendType, BendType>> = {
  [model.BendType.Bend]: "bend",
  [model.BendType.BendRelease]: "bendRelease",
  [model.BendType.Prebend]: "preBend",
  [model.BendType.PrebendRelease]: "preBendRelease",
};

/**
 * A bend as one of the preset shapes (docs/spec/import-export.md, 2.1): by its type, or, for a type
 * the score has not, the nearest shape (reported): bent before it is struck when it starts up, let
 * down when it ends lower than its highest point. So many semitones as its highest point, rounded,
 * 1 to 4. None for a bend that never goes up.
 */
function bendOf(note: AtNote, report: Report, bar: number): NoteJSON["bend"] {
  const points = note.bendPoints ?? [];
  const highest = Math.max(0, ...points.map((point) => point.value));
  if (highest <= 0) return undefined;
  let type = BENDS[note.bendType];
  if (type === undefined) {
    report.add("bend", bar);
    const pre = (points[0]?.value ?? 0) > 0;
    const released = (points.at(-1)?.value ?? 0) < highest;
    type = pre ? (released ? "preBendRelease" : "preBend") : released ? "bendRelease" : "bend";
  }
  // alphaTab's bend values are quarter tones.
  const semitones = Math.round(highest / 2);
  if (semitones < 1 || semitones > 4) report.add("bend", bar);
  return { type, semitones: Math.min(4, Math.max(1, semitones)) };
}

const ACCIDENTALS: Partial<Record<alphaTab.model.NoteAccidentalMode, number>> = {
  [model.NoteAccidentalMode.ForceDoubleFlat]: -2,
  [model.NoteAccidentalMode.ForceFlat]: -1,
  [model.NoteAccidentalMode.ForceNatural]: 0,
  [model.NoteAccidentalMode.ForceSharp]: 1,
  [model.NoteAccidentalMode.ForceDoubleSharp]: 2,
};

const ACCIDENTAL_TEXT: Record<number, string> = { [-2]: "bb", [-1]: "b", 0: "", 1: "#", 2: "##" };
const LETTER_CLASSES = [0, 2, 4, 5, 7, 9, 11];

/**
 * How a pitched note is spelled when the file says how (an accidental forced, a natural too): the
 * letter that the accidental moves to the pitch. None when the file leaves it to the key, or when
 * no letter is that far from the pitch.
 */
function spellOf(note: AtNote, pitch: number): string | undefined {
  const alter = ACCIDENTALS[note.accidentalMode];
  if (alter === undefined) return undefined;
  const letter = LETTER_CLASSES.indexOf((((pitch - alter) % 12) + 12) % 12);
  return letter < 0 ? undefined : `${NOTE_LETTERS[letter]}${ACCIDENTAL_TEXT[alter]}`;
}

/** The note key and fields of an alphaTab note in a part, or null (reported) when the part cannot hold it. */
function readNote(note: AtNote, kind: PartKind, strings: number, bar: number, report: Report): [string, NoteJSON] | null {
  const json: NoteJSON = {};
  let key: string;
  if (kind === "fretted") {
    const string = strings - note.string + 1;
    if (!note.isStringed || string < 1 || string > strings) {
      report.add("technique", bar);
      return null;
    }
    if (note.fret > MAX_FRET) {
      report.add("fret", bar);
      return null;
    }
    key = `s${string}`;
    // A dead note on no fret, as the editor makes one: the projection plays both alike.
    if (!(note.isDead && note.fret === 0)) json.fret = note.fret;
  } else if (kind === "percussion") {
    const articulations = note.beat.voice.bar.staff.track.percussionArticulations;
    const id = note.percussionArticulation < articulations.length ? articulations[note.percussionArticulation]?.id : note.percussionArticulation;
    if (id === undefined || !Number.isInteger(id) || id < 0 || id > 127) {
      report.add("drum", bar);
      return null;
    }
    key = `p${id}`;
  } else {
    const pitch = note.realValueWithoutHarmonic;
    if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) {
      report.add("pitch", bar);
      return null;
    }
    key = `n${pitch}`;
    const spell = spellOf(note, pitch);
    if (spell !== undefined) json.spell = spell;
  }

  const fretted = kind === "fretted";
  /** Set a technique when the part's kind has it; report it when it has not. */
  const technique = <Field extends keyof NoteJSON>(field: Field, value: NoteJSON[Field], fits: boolean, loss: ImportLoss = "technique") => {
    if (fits) json[field] = value;
    else report.add(loss, bar);
  };
  if (note.isDead) technique("dead", true, fretted);
  if (note.isTieDestination) technique("tie", true, kind !== "percussion");
  if (note.isGhost) technique("ghost", true, kind !== "pitched");
  if (note.accentuated !== model.AccentuationType.None) {
    // A heavy accent as an accent; a tenuto the score has not.
    if (note.accentuated !== model.AccentuationType.Normal) report.add("technique", bar);
    if (note.accentuated !== model.AccentuationType.Tenuto) json.accent = true;
  }
  if (note.isStaccato) technique("staccato", true, kind !== "percussion");
  if (note.isHammerPullOrigin) technique("legato", true, fretted);
  if (note.slideOutType !== model.SlideOutType.None) {
    const slide = SLIDE_OUTS[note.slideOutType];
    if (slide === undefined) report.add("slide", bar);
    else technique("slideOut", slide, fretted);
  }
  if (note.slideInType !== model.SlideInType.None) {
    const slide = SLIDE_INS[note.slideInType];
    if (slide === undefined) report.add("slide", bar);
    else technique("slideIn", slide, fretted);
  }
  if (note.hasBend) {
    const bend = bendOf(note, report, bar);
    if (bend) technique("bend", bend, fretted, "bend");
  }
  if (note.vibrato !== model.VibratoType.None) {
    if (note.vibrato !== model.VibratoType.Slight) report.add("technique", bar);
    technique("vibrato", true, fretted);
  }
  if (note.isPalmMute) technique("palmMute", true, fretted);
  if (note.isLetRing) technique("letRing", true, fretted);
  if (note.beat.tap) technique("tap", true, fretted);
  if (note.harmonicType !== model.HarmonicType.None) {
    const harmonic = HARMONICS[note.harmonicType];
    if (harmonic === undefined) report.add("harmonic", bar);
    else technique("harmonic", harmonic, fretted, "harmonic");
  }
  if (note.isTrill) report.add("trill", bar);
  if (note.leftHandFinger >= 0 || note.rightHandFinger >= 0) report.add("fingering", bar);
  if (note.ornament !== model.NoteOrnament.None) report.add("ornament", bar);
  if (note.isSlurOrigin && !note.isHammerPullOrigin) report.add("slur", bar);
  if (note.isLeftHandTapped) report.add("technique", bar);
  return [key, json];
}

/** What a part being read keeps from beat to beat in each of its voices: the dynamic in force. */
interface VoiceState {
  dynamic: (typeof DYNAMICS)[number];
}

/** The dynamic a beat is at, as the score has it; none (reported) for one it has not. */
function dynamicOf(beat: AtBeat, report: Report, bar: number): (typeof DYNAMICS)[number] | undefined {
  const named = DYNAMIC_NAMES[beat.dynamics];
  if (named !== undefined) return named;
  report.add("dynamic", bar);
  return DYNAMIC_NEAREST[beat.dynamics];
}

/**
 * A beat of the file as a beat of the score, or null for one it has not (reported): a grace note,
 * or a note value shorter than a 64th or longer than a whole. A dynamic is written where it changes
 * in its voice: in the score it holds from its beat on (docs/spec/schema.md, section 8).
 */
function readBeat(beat: AtBeat, kind: PartKind, strings: number, bar: number, state: VoiceState, report: Report): BeatJSON | null {
  if (beat.graceType !== model.GraceType.None) {
    report.add("grace", bar);
    return null;
  }
  const value = noteValueOf(beat.duration);
  if (value === undefined) {
    report.add("duration", bar);
    return null;
  }
  if (beat.dots > 2) report.add("dots", bar);
  const json: BeatJSON = { id: newId(), value, dots: Math.min(2, Math.max(0, beat.dots)) as 0 | 1 | 2, notes: {} };
  if (beat.hasTuplet) {
    const tuplet = tupletSchema.safeParse({ actual: beat.tupletNumerator, normal: beat.tupletDenominator });
    if (tuplet.success) json.tuplet = tuplet.data;
    else report.add("tuplet", bar);
  }
  for (const note of beat.notes) {
    const read = readNote(note, kind, strings, bar, report);
    if (read === null) continue;
    const [key, fields] = read;
    // Two notes on one key: C♯ and D♭ at once, or the same drum twice.
    if (key in json.notes) report.add(kind === "pitched" ? "pitch" : "technique", bar);
    else json.notes[key] = fields;
  }

  const fretted = kind === "fretted";
  if (beat.brushType === model.BrushType.BrushDown || beat.brushType === model.BrushType.BrushUp) {
    if (fretted) json.stroke = beat.brushType === model.BrushType.BrushDown ? "down" : "up";
    else report.add("technique", bar);
  } else if (beat.brushType !== model.BrushType.None) {
    report.add("arpeggio", bar);
  }
  if (beat.slap || beat.pop) {
    if (!fretted) report.add("technique", bar);
    // One of the two on a beat: slap, as reading keeps it (docs/spec/schema.md, section 6).
    else if (beat.slap) json.slap = true;
    else json.pop = true;
    if (fretted && beat.slap && beat.pop) report.add("technique", bar);
  }
  const dynamic = dynamicOf(beat, report, bar);
  if (dynamic !== undefined && dynamic !== state.dynamic) {
    json.dynamic = dynamic;
    state.dynamic = dynamic;
  }
  if (beat.text) json.text = cut(beat.text, MAX_BEAT_TEXT, report, "textTruncated", bar);
  const [syllable, ...others] = beat.lyrics ?? [];
  if (syllable !== undefined) {
    if (kind === "pitched") json.lyric = cut(syllable, MAX_LYRIC, report, "lyricTruncated", bar);
    else if (syllable !== "") report.add("lyricOnUnpitched", bar);
  }
  if (others.some((line) => line !== "")) report.add("lyricLines", bar);
  if (beat.crescendo !== model.CrescendoType.None) report.add("crescendo", bar);
  if (beat.hasChord) report.add("chord", bar);
  if (beat.slashed) report.add("slashed", bar);
  if (beat.ottava !== model.Ottavia.Regular) report.add("ottava", bar);
  if (beat.hasWhammyBar) report.add("whammy", bar);
  if (beat.isTremolo) report.add(kind === "percussion" ? "technique" : "tremolo", bar);
  if (beat.fermata) report.add("fermata", bar);
  if (beat.vibrato !== model.VibratoType.None || beat.deadSlapped || beat.golpe !== model.GolpeType.None || beat.fade !== model.FadeType.None || beat.pickStroke !== model.PickStroke.None) {
    report.add("technique", bar);
  }
  return json;
}

/** Whether a beat says nothing: a rest with nothing written on it. A voice of such beats is an empty one. */
function saysNothing(beat: BeatJSON): boolean {
  return Object.keys(beat.notes).length === 0 && Object.keys(beat).every((field) => ["id", "value", "dots", "tuplet", "notes"].includes(field));
}

/** The beats of a voice of the file, none for one with nothing in it (a whole-bar rest is an empty voice). */
function readVoice(voice: alphaTab.model.Voice | undefined, kind: PartKind, strings: number, bar: number, state: VoiceState, report: Report): BeatJSON[] {
  if (voice === undefined) return [];
  const beats: BeatJSON[] = [];
  for (const beat of voice.beats) {
    if (beat.isEmpty) continue;
    const read = readBeat(beat, kind, strings, bar, state, report);
    if (read) beats.push(read);
  }
  return beats.every(saysNothing) ? [] : beats;
}

/** Whether a voice of the file has anything in it. */
function voiceHolds(voice: alphaTab.model.Voice): boolean {
  return voice.beats.some((beat) => !beat.isEmpty);
}

/** The clef a staff of a pitched part has, from its first bar; another than the score has is a treble clef (reported). */
function clefOf(staff: AtStaff, report: Report): Staff["clef"] {
  const bar = staff.bars[0];
  let clef: Staff["clef"] = "treble";
  if (bar?.clef === model.Clef.F4 && bar.clefOttava === model.Ottavia.Regular) clef = "bass";
  else if (bar?.clef === model.Clef.G2 && bar.clefOttava === model.Ottavia._8vb) clef = "treble-8vb";
  else if (bar !== undefined && !(bar.clef === model.Clef.G2 && bar.clefOttava === model.Ottavia.Regular)) report.add("clef");
  // A clef changed later on is not the score's: the staff keeps the first.
  const changes = staff.bars.findIndex((other) => other.clef !== bar?.clef || other.clefOttava !== bar.clefOttava);
  if (changes > 0) report.add("clef", changes);
  return clef;
}

/** A track of the file as a part of `kind` (`kindsOf`), with the content of every bar. */
function readPart(track: AtTrack, kind: PartKind, barIds: readonly string[], report: Report): PartJSON {
  const name = cut(track.name, MAX_PART_NAME, report, "partNameTruncated");
  const first = track.staves[0] as AtStaff;
  const staffCount = kind === "pitched" ? Math.min(MAX_STAVES, track.staves.length) : 1;
  if (track.staves.length > staffCount) report.add("staves");
  const staves = track.staves.slice(0, staffCount);
  const tuning = kind === "fretted" ? [...first.stringTuning.tunings] : [];
  if (kind === "pitched" && first.stringTuning.tunings.length > 0) {
    if (first.showTablature) report.add("strings");
    // A guitar or a bass shown as notes only: read as notes, its tuning and frets left out. Every
    // staff written as notes has a tuning too when read from Guitar Pro 6 to 8 (`kindOf`), a piano
    // or a voice of this score among them: the program tells a guitar or a bass (General MIDI 25 to 40).
    else if (STRINGED_PROGRAMS.includes(track.playbackInfo.program)) report.add("tablatureHidden");
  }
  let capo = 0;
  if (kind === "fretted") {
    capo = Math.min(MAX_CAPO, Math.max(0, first.capo));
    if (capo !== first.capo) report.add("capo");
  }
  if (kind === "pitched" && staves.some((staff) => staff.transpositionPitch !== 0 || staff.displayTranspositionPitch !== 0)) report.add("transposition");
  const program = kind === "percussion" ? 0 : Math.min(127, Math.max(0, track.playbackInfo.program));

  const states = staves.map(() => [{ dynamic: START_DYNAMIC }, { dynamic: START_DYNAMIC }] as VoiceState[]);
  const content: PartJSON["content"] = {};
  barIds.forEach((barId, barIndex) => {
    const voices: Record<string, BeatJSON[]> = {};
    staves.forEach((staff, staffIndex) => {
      const bar = staff.bars[barIndex] as AtBar | undefined;
      const state = states[staffIndex] as VoiceState[];
      if (bar?.sustainPedals.length) report.add("pedal", barIndex);
      if (bar && kind !== "pitched" && bar.clefOttava !== model.Ottavia.Regular) report.add("ottava", barIndex);
      // The first voice of each staff is always written, the second only when it has beats (as docToJson writes them).
      voices[voiceKey(staffIndex, 0)] = readVoice(bar?.voices[0], kind, tuning.length, barIndex, state[0] as VoiceState, report);
      const second = readVoice(bar?.voices[1], kind, tuning.length, barIndex, state[1] as VoiceState, report);
      if (second.length > 0) voices[voiceKey(staffIndex, 1)] = second;
      if (bar?.voices.slice(2).some(voiceHolds)) report.add("voices", barIndex);
    });
    content[barId] = voices;
  });

  const id = newId();
  const staffClefs: Staff[] = kind === "pitched" ? staves.map((staff) => ({ clef: clefOf(staff, report) })) : [...KIND_DEFAULTS[kind].staves];
  return { id, name, kind, tuning, capo, program, staves: staffClefs, content } as PartJSON;
}

/**
 * The staff whose bars give the key of each bar: the first that is not a drum staff. A drum staff has
 * no key: alphaTab reads it in C major, whatever the other staves are in.
 */
function keyStaffOf(score: AtScore): AtStaff | undefined {
  const staves = score.tracks.flatMap((track) => track.staves);
  return staves.find((staff) => !staff.isPercussion) ?? staves[0];
}

const KEY_MODES = { [model.KeySignatureType.Major]: "major", [model.KeySignatureType.Minor]: "minor" } as const;

/**
 * The bars of the file (docs/spec/import-export.md, 2.1). The tempo is written on the first bar, as a
 * new score has it, and where it changes; the key where it changes from C major or the key before.
 */
function readBars(score: AtScore, report: Report): BarJSON[] {
  const keyStaff = keyStaffOf(score);
  let tempoInForce: number | undefined;
  let keyInForce: KeySignature = { ...DEFAULT_KEY_SIG };
  return score.masterBars.map((masterBar, index) => {
    const bar: BarJSON = { id: newId(), timeSig: timeSigOf(masterBar, report, index) };

    const atStart = masterBar.tempoAutomations.filter((automation) => automation.ratioPosition === 0);
    if (masterBar.tempoAutomations.length > atStart.length) report.add("tempoInBar", index);
    if (masterBar.tempoAutomations.some((automation) => automation.text !== "")) report.add("tempoText", index);
    let tempo = atStart.at(-1)?.value ?? (index === 0 ? score.tempo : undefined);
    if (index === 0 && !(tempo !== undefined && tempo > 0)) tempo = DEFAULT_TEMPO;
    if (tempo !== undefined) {
      const kept = Math.min(TEMPO_RANGE.max, Math.max(TEMPO_RANGE.min, tempo));
      if (kept !== tempo) report.add("tempoOutOfRange", index);
      if (kept !== tempoInForce) bar.tempo = kept;
      tempoInForce = kept;
    }

    const keyBar = keyStaff?.bars[index];
    if (keyBar !== undefined) {
      const key: KeySignature = { fifths: Math.min(7, Math.max(-7, keyBar.keySignature as number)), mode: KEY_MODES[keyBar.keySignatureType] ?? "major" };
      if (key.fifths !== keyInForce.fifths || key.mode !== keyInForce.mode) bar.keySig = key;
      keyInForce = key;
    }

    if (masterBar.isRepeatStart) bar.repeatStart = true;
    if (masterBar.repeatCount >= 2) {
      bar.repeatEnd = Math.min(MAX_REPEAT, masterBar.repeatCount);
      if (masterBar.repeatCount > MAX_REPEAT) report.add("repeatCount", index);
    }
    const voltas = Array.from({ length: 8 }, (_, bit) => bit + 1).filter((pass) => (masterBar.alternateEndings & (1 << (pass - 1))) !== 0);
    if (voltas.length > 0) bar.voltas = voltas;
    const section = masterBar.section?.text || masterBar.section?.marker || "";
    if (section !== "") bar.section = cut(section, MAX_SECTION_NAME, report, "sectionTruncated", index);
    if (index === 0 && masterBar.isAnacrusis) bar.anacrusis = true;

    if (masterBar.directions?.size) report.add("jump", index);
    if (masterBar.tripletFeel !== model.TripletFeel.NoTripletFeel) report.add("swing", index);
    if (masterBar.fermata?.size) report.add("fermata", index);
    return bar;
  });
}

/** A bar's time signature, 4/4 (reported) for one the score cannot hold. */
function timeSigOf(masterBar: alphaTab.model.MasterBar, report: Report, index: number): TimeSignature {
  const read = timeSigSchema.safeParse({ numerator: masterBar.timeSignatureNumerator, denominator: masterBar.timeSignatureDenominator });
  if (read.success) return read.data;
  report.add("timeSignature", index);
  return { numerator: 4, denominator: 4 };
}

/**
 * A title or an artist with plain spaces: alphaTab's MusicXML reader makes each space of them a
 * no-break space, to draw them as written. The score keeps text, not how it is drawn.
 */
function spaced(text: string): string {
  return text.replaceAll(" ", " ");
}

/**
 * The title a file without one gets: its own name, without the extension, trimmed; the whole name
 * trimmed when nothing is left without it (".gp"). Empty only for a name that is all white space,
 * which the caller does not give (docs/spec/import-export.md, 2.3).
 */
function titleOfFile(fileName: string): string {
  return fileName.replace(/\.[^.]*$/, "").trim() || fileName.trim();
}

/** The score alphaTab reads from a file, or null when it cannot read it. */
function load(bytes: Uint8Array): AtScore | null {
  // A file alphaTab cannot read is an answer (`unreadable`), not an error of the page: its loader
  // would log one to the console for each (#70). Its log level is global, so it is put back.
  const level = alphaTab.Logger.logLevel;
  alphaTab.Logger.logLevel = alphaTab.LogLevel.None;
  try {
    return alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, new alphaTab.Settings());
  } catch {
    return null;
  } finally {
    alphaTab.Logger.logLevel = level;
  }
}

/**
 * Read a Guitar Pro (3 to 7, GPX) or MusicXML file as a new score, with what it could not hold
 * (docs/spec/import-export.md, section 2). No score at all for a file over a limit: none of it is
 * cut to fit. Every id is new.
 */
export function importScore(bytes: Uint8Array, fileName: string): ImportResult {
  if (bytes.length > MAX_IMPORT_FILE_BYTES) return { ok: false, failure: "fileTooLarge" };
  const score = load(bytes);
  if (score === null) return { ok: false, failure: "unreadable" };
  const kinds = kindsOf(score);
  if (kinds.length > MAX_PARTS) return { ok: false, failure: "tooManyParts" };
  if (kinds.filter((kind) => kind !== "percussion").length > MAX_NON_PERCUSSION_PARTS) return { ok: false, failure: "tooManyNonDrumParts" };
  if (score.masterBars.length > MAX_BARS) return { ok: false, failure: "tooManyBars" };

  const report = new Report();
  const title = cut(spaced(score.title).trim() || titleOfFile(fileName), MAX_TITLE, report, "titleTruncated");
  const artist = score.artist ? cut(spaced(score.artist), MAX_TITLE, report, "artistTruncated") : undefined;
  const bars = readBars(score, report);
  const barIds = bars.map((bar) => bar.id);
  const parts = score.tracks.map((track, index) => readPart(track, kinds[index] as PartKind, barIds, report));
  const json: ScoreJSON = { schemaVersion: SCHEMA_VERSION, title, ...(artist ? { artist } : {}), bars, parts };
  if (jsonBytes(json) > MAX_IMPORT_BYTES) return { ok: false, failure: "tooLarge" };
  const checked = importedScoreSchema.safeParse(json);
  if (!checked.success) return { ok: false, failure: "invalid" };
  return { ok: true, score: checked.data, report: report.list() };
}
