// Export (docs/spec/import-export.md, section 3): the projection of a score, written by alphaTab as a
// Guitar Pro 7 file or a MIDI file. What the projection leaves out cannot be exported.
import * as alphaTab from "@coderline/alphatab";
import { COMMON_TIME, type KeySignature, keySigsOf, SCHEMA_VERSION, type ScoreJSON } from "@studio/score-model";

import { beatOf, KEY_SIGNATURE_TYPES, type Projection, projectScore } from "./projection";

/**
 * The projection to export, with what only a file holds: the artist, and the empty syllable of a
 * melisma, which the drawing leaves out (`[""]` would be a syllable of nothing there) but a file
 * keeps, so that reading it back gives the same lyric.
 */
function projectForExport(json: ScoreJSON, settings: alphaTab.Settings): Projection {
  const projection = projectScore(json, settings);
  projection.score.artist = json.artist ?? "";
  // A drum staff is drawn with no key (C major), but a Guitar Pro 7 file has one key a bar, which
  // alphaTab writes from the first staff of the score: a score whose first part is drums would lose
  // its keys. In the file, drum staves are in the key in force too.
  const keys = keySigsOf(json.bars);
  for (const track of projection.score.tracks) {
    if (!track.staves[0]?.isPercussion) continue;
    for (const staff of track.staves) {
      staff.bars.forEach((bar, index) => {
        const key = keys[index] as KeySignature;
        bar.keySignature = key.fifths as alphaTab.model.KeySignature;
        bar.keySignatureType = KEY_SIGNATURE_TYPES[key.mode];
      });
    }
  }
  for (const part of json.parts) {
    for (const voices of Object.values(part.content)) {
      for (const beats of Object.values(voices)) {
        for (const beat of beats) {
          if (beat.lyric !== "") continue;
          const projected = beatOf(projection, beat.id);
          if (projected) projected.lyrics = [""];
        }
      }
    }
  }
  return projection;
}

type Articulation = alphaTab.model.InstrumentArticulation;

/**
 * alphaTab's drum kit, by articulation id (the score's drum keys, docs/spec/schema.md section 7).
 * Its table is not public: it is read back from a Guitar Pro 7 file of a drum part with none of its
 * own, which alphaTab writes with the whole kit in it. Made for each export that has drums, with its
 * settings: a file of one empty bar.
 */
function drumKit(settings: alphaTab.Settings): Map<number, Articulation> {
  const empty: ScoreJSON = {
    schemaVersion: SCHEMA_VERSION,
    title: "",
    bars: [{ id: "bar", timeSig: { ...COMMON_TIME } }],
    parts: [{ id: "drums", name: "", kind: "percussion", tuning: [], capo: 0, program: 0, staves: [{ clef: "neutral" }], content: {} }],
  };
  const bytes = new alphaTab.exporter.Gp7Exporter().export(projectScore(empty, settings).score, settings);
  const articulations = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings).tracks[0]?.percussionArticulations ?? [];
  return new Map(articulations.map((articulation) => [articulation.id, articulation]));
}

/**
 * Give each drum part the articulations its notes play, and each note the index of its own there.
 * The projection leaves a drum note's articulation id in place of that index (alphaTab draws and
 * plays it so); alphaTab 1.9's Guitar Pro 7 writer then writes its whole kit for the part but the
 * id as the index into it, and a file read back plays other drums (a hi-hat, 42, as the 43rd of the
 * kit, an agogo).
 */
function listDrums(score: alphaTab.model.Score, settings: alphaTab.Settings): void {
  const drums = score.tracks.filter((track) => track.staves[0]?.isPercussion);
  if (drums.length === 0) return;
  const kit = drumKit(settings);
  for (const track of drums) {
    for (const staff of track.staves) {
      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            for (const note of beat.notes) {
              const articulation = kit.get(note.percussionArticulation);
              if (articulation) note.percussionArticulation = track.getOrRegisterPercussionArticulation(articulation);
            }
          }
        }
      }
    }
  }
}

/** A score as a Guitar Pro 7 file (`.gp`). */
export function exportGp7(json: ScoreJSON): Uint8Array {
  const settings = new alphaTab.Settings();
  const { score } = projectForExport(json, settings);
  listDrums(score, settings);
  return new alphaTab.exporter.Gp7Exporter().export(score, settings);
}

/**
 * The MIDI alphaTab makes of a score's projection: what the player plays, the same projection and
 * the same generator, without the metronome and the count-in, and as a standard MIDI file (a bend
 * bends its channel). The mixer is the player's, not the score's: it is not applied.
 */
function midiOf(json: ScoreJSON): alphaTab.midi.MidiFile {
  const settings = new alphaTab.Settings();
  const file = new alphaTab.midi.MidiFile();
  const { score } = projectScore(json, settings);
  if (score.masterBars.length > 0 && score.tracks.length > 0) {
    new alphaTab.midi.MidiFileGenerator(score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(file, true)).generate();
  }
  return file;
}

/** A score as a standard MIDI file (`.mid`). A score with no bars or no parts has no events. */
export function exportMidi(json: ScoreJSON): Uint8Array {
  return midiOf(json).toBinary();
}
