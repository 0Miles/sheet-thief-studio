// The projection (CONTEXT.md): a score as plain data becomes the model alphaTab draws and plays.
// One way only: nothing built here is ever written back to the score.
import * as alphaTab from "@coderline/alphatab";
import { type BarJSON, barTicks, type BeatJSON, beatTicks, type NoteJSON, type NoteValue, type PartJSON, type ScoreJSON, WHOLE } from "@studio/score-model";

type AtScore = alphaTab.model.Score;
type AtTrack = alphaTab.model.Track;
type AtStaff = alphaTab.model.Staff;
type AtBar = alphaTab.model.Bar;
type AtBeat = alphaTab.model.Beat;
type AtNote = alphaTab.model.Note;

const { model } = alphaTab;

/** Quarter notes per minute of a score whose first bar gives no tempo. */
export const DEFAULT_TEMPO = 120;

/** The MIDI channel every percussion part plays on. */
const PERCUSSION_CHANNEL = 9;

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

/** How many voices each staff of a part needs: the most any of its bars uses, at least one. */
function staffVoiceCounts(part: PartJSON): number[] {
  const counts = [1];
  for (const voices of Object.values(part.content)) {
    for (const key of Object.keys(voices)) {
      const { staff, voice } = parseVoice(key);
      while (counts.length <= staff) counts.push(1);
      counts[staff] = Math.max(counts[staff] as number, voice + 1);
    }
  }
  return counts;
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

function accidentalModeOf(spell: string | undefined): alphaTab.model.NoteAccidentalMode {
  const accidental = spell?.slice(1) ?? "";
  switch (accidental) {
    case "#":
      return model.NoteAccidentalMode.ForceSharp;
    case "b":
      return model.NoteAccidentalMode.ForceFlat;
    case "##":
    case "x":
      return model.NoteAccidentalMode.ForceDoubleSharp;
    case "bb":
      return model.NoteAccidentalMode.ForceDoubleFlat;
    default:
      return model.NoteAccidentalMode.Default;
  }
}

/**
 * A note of the score as an alphaTab note, or null when its key does not fit the part.
 * Keys: "s3" is string 3 (1 is the highest), "p38" a drum piece (the alphaTab percussion
 * articulation id, see drums.ts), "n61" a MIDI pitch.
 */
function projectNote(part: PartJSON, key: string, json: NoteJSON): AtNote | null {
  const number = Number(key.slice(1));
  if (!Number.isInteger(number)) return null;
  const note = new model.Note();
  if (key.startsWith("s") && part.kind === "fretted") {
    if (number < 1 || number > part.tuning.length || json.fret === undefined) return null;
    // alphaTab counts strings from the lowest; the score from the highest.
    note.string = part.tuning.length - number + 1;
    note.fret = json.fret;
  } else if (key.startsWith("p") && part.kind === "percussion") {
    note.percussionArticulation = number;
  } else if (key.startsWith("n") && part.kind === "pitched") {
    note.octave = Math.floor(number / 12);
    note.tone = number % 12;
    note.accidentalMode = accidentalModeOf(json.spell);
  } else {
    return null;
  }
  if (json.tie) note.isTieDestination = true;
  if (json.ghost) note.isGhost = true;
  return note;
}

function rest(value: NoteValue): AtBeat {
  const beat = new model.Beat();
  beat.duration = value as alphaTab.model.Duration;
  return beat;
}

function projectBeat(part: PartJSON, json: BeatJSON): AtBeat {
  const beat = rest(json.value);
  beat.dots = json.dots;
  if (json.tuplet) {
    beat.tupletNumerator = json.tuplet.actual;
    beat.tupletDenominator = json.tuplet.normal;
  }
  for (const [key, noteJson] of Object.entries(json.notes)) {
    const note = projectNote(part, key, noteJson);
    if (note) beat.addNote(note);
  }
  return beat;
}

/** One bar of one staff of a part, with every voice the staff has. Returns the ids of its beats by voice. */
function projectBar(part: PartJSON, bar: BarJSON, staff: number, voiceCount: number): { bar: AtBar; beatIds: string[][] } {
  const atBar = new model.Bar();
  atBar.clef = part.kind === "percussion" ? model.Clef.Neutral : model.Clef.G2;
  const beatIds: string[][] = [];
  const content = part.content[bar.id] ?? {};
  for (let voice = 0; voice < voiceCount; voice++) {
    const atVoice = new model.Voice();
    atBar.addVoice(atVoice);
    const beats = content[`${staff}:${voice}`] ?? [];
    beatIds.push(beats.map((beat) => beat.id));
    for (const beat of beats) atVoice.addBeat(projectBeat(part, beat));
    if (beats.length === 0) {
      // An empty first voice is a whole-bar rest; other voices stay invisible.
      const filler = rest(1);
      filler.isEmpty = voice > 0;
      atVoice.addBeat(filler);
      continue;
    }
    // A voice that does not fill its bar is completed with rests, here only (it stays flagged).
    const held = beats.reduce((sum, beat) => sum + beatTicks(beat), 0);
    for (const value of restsFilling(held, barTicks(bar.timeSig))) atVoice.addBeat(rest(value));
  }
  return { bar: atBar, beatIds };
}

function projectTrack(part: PartJSON, channels: { next: number }): AtTrack {
  const track = new model.Track();
  track.name = part.name;
  track.shortName = part.name;
  const info = track.playbackInfo;
  if (part.kind === "percussion") {
    info.program = 0;
    info.primaryChannel = PERCUSSION_CHANNEL;
    info.secondaryChannel = PERCUSSION_CHANNEL;
  } else {
    const take = (): number => {
      if (channels.next === PERCUSSION_CHANNEL) channels.next++;
      // Out of channels (more than seven pitched parts): share the last one rather than fail.
      return Math.min(channels.next++, 15);
    };
    info.program = part.program;
    info.primaryChannel = take();
    info.secondaryChannel = take();
  }
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
  const projection: Projection = {
    score,
    barIds: json.bars.map((bar) => bar.id),
    barIndex: new Map(json.bars.map((bar, index) => [bar.id, index])),
    partIds: json.parts.map((part) => part.id),
    partIndex: new Map(json.parts.map((part, index) => [part.id, index])),
    addresses: new Map(),
    voiceBeatIds: new Map(),
  };

  json.bars.forEach((bar, index) => {
    const masterBar = new model.MasterBar();
    masterBar.timeSignatureNumerator = bar.timeSig.numerator;
    masterBar.timeSignatureDenominator = bar.timeSig.denominator;
    const tempo = bar.tempo ?? (index === 0 ? DEFAULT_TEMPO : undefined);
    if (tempo !== undefined) masterBar.tempoAutomations.push(model.Automation.buildTempoAutomation(false, 0, tempo, 2));
    score.addMasterBar(masterBar);
  });

  const channels = { next: 0 };
  json.parts.forEach((part, trackIndex) => {
    const track = projectTrack(part, channels);
    const voiceCounts = staffVoiceCounts(part);
    track.ensureStaveCount(voiceCounts.length);
    score.addTrack(track);
    track.staves.forEach((staff, staffIndex) => {
      setUpStaff(staff, part);
      json.bars.forEach((bar, barIndex) => {
        const built = projectBar(part, bar, staffIndex, voiceCounts[staffIndex] as number);
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
 * Rebuild the bars named by `barIds` inside an existing projection, leaving every other bar of
 * the alphaTab model as it is (same objects). Returns the index of the first rebuilt bar, or
 * null when the change is not one this can do (a bar, a part or a voice count changed): the
 * caller then projects the whole score again.
 */
export function replaceBars(projection: Projection, json: ScoreJSON, barIds: readonly string[], settings: alphaTab.Settings, timings?: ProjectionTimings): number | null {
  const started = performance.now();
  if (json.bars.length !== projection.barIds.length || json.parts.length !== projection.partIds.length) return null;
  const indexes = barIds.map((id) => projection.barIndex.get(id));
  if (indexes.some((index) => index === undefined)) return null;
  const voiceCounts = json.parts.map(staffVoiceCounts);
  const sameShape = json.parts.every((part, trackIndex) => {
    const track = projection.score.tracks[trackIndex];
    const counts = voiceCounts[trackIndex] as number[];
    return (
      projection.partIds[trackIndex] === part.id &&
      track?.staves.length === counts.length &&
      track.staves.every((staff, staffIndex) => staff.bars[0]?.voices.length === counts[staffIndex])
    );
  });
  if (!sameShape) return null;

  let finishing = 0;
  for (const barIndex of indexes as number[]) {
    const bar = json.bars[barIndex] as BarJSON;
    json.parts.forEach((part, trackIndex) => {
      const track = projection.score.tracks[trackIndex] as AtTrack;
      track.staves.forEach((staff, staffIndex) => {
        const old = staff.bars[barIndex] as AtBar;
        // Drop the ids of the old beats before the new ones take their place.
        old.voices.forEach((_, voice) => {
          for (const id of projection.voiceBeatIds.get(voiceKey(trackIndex, staffIndex, barIndex, voice)) ?? []) projection.addresses.delete(id);
        });
        const built = projectBar(part, bar, staffIndex, (voiceCounts[trackIndex] as number[])[staffIndex] as number);
        const atBar = built.bar;
        atBar.staff = staff;
        atBar.index = barIndex;
        atBar.previousBar = old.previousBar;
        atBar.nextBar = old.nextBar;
        if (old.previousBar) old.previousBar.nextBar = atBar;
        if (old.nextBar) old.nextBar.previousBar = atBar;
        staff.bars[barIndex] = atBar;
        recordBeatIds(projection, trackIndex, staffIndex, barIndex, built.beatIds);
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
      });
    });
  }
  if (timings) {
    timings.finish = finishing;
    timings.build = performance.now() - started - finishing;
  }
  return Math.min(...(indexes as number[]));
}
