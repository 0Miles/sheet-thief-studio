// Import and export (docs/spec/import-export.md): the round trip of the samples in tests/fixtures
// (section 4: import, project, export as Guitar Pro 7, import again), the import report, the limits
// on an import, and the MIDI export against what the player plays.
import { writeFileSync } from "node:fs";

import * as alphaTab from "@coderline/alphatab";
import { type BeatJSON, defaultSpelling, keySigsOf, MAX_BARS, MAX_IMPORT_BYTES, MAX_NON_PERCUSSION_PARTS, MAX_PARTS, type PartJSON, type ScoreJSON } from "@studio/score-model";
import { describe, expect, test } from "vitest";

import { exportGp7, exportMidi, type ImportReportItem, type ImportResult, importScore, MAX_IMPORT_FILE_BYTES } from "../src/index";
import { projectScore } from "../src/projection";
import { fixture } from "./fixtures";
import { GP7_SAMPLE } from "./fixtures/samples";

/** A score as the tests compare scores: ids are an import's own, so bars and parts are numbered and beats have none. */
function withoutIds(score: ScoreJSON): unknown {
  const barNames = new Map(score.bars.map((bar, index) => [bar.id, `bar ${index + 1}`]));
  return {
    ...score,
    bars: score.bars.map(({ id, ...bar }) => ({ ...bar, id: barNames.get(id) })),
    parts: score.parts.map((part, index) => ({
      ...part,
      id: `part ${index + 1}`,
      content: Object.fromEntries(
        Object.entries(part.content).map(([barId, voices]) => [
          barNames.get(barId),
          Object.fromEntries(Object.entries(voices).map(([voice, beats]) => [voice, beats.map((beat) => Object.fromEntries(Object.entries(beat).filter(([field]) => field !== "id")))])),
        ]),
      ),
    })),
  };
}

/**
 * A score with every pitched note spelled: a note with no spelling of its own as the key in force
 * spells it. Guitar Pro 7 writes the accidental of every note, so a note that had none comes back
 * with the one it was drawn with (docs/spec/import-export.md, section 4).
 */
function spelled(score: ScoreJSON): ScoreJSON {
  const keys = new Map(keySigsOf(score.bars).map((key, index) => [score.bars[index]!.id, key]));
  const spell = (beat: BeatJSON, barId: string): BeatJSON => ({
    ...beat,
    notes: Object.fromEntries(Object.entries(beat.notes).map(([key, note]) => [key, { ...note, spell: note.spell ?? defaultSpelling(Number(key.slice(1)), keys.get(barId)!) }])),
  });
  return {
    ...score,
    parts: score.parts.map((part): PartJSON => {
      if (part.kind !== "pitched") return part;
      const content = Object.fromEntries(Object.entries(part.content).map(([barId, voices]) => [barId, Object.fromEntries(Object.entries(voices).map(([voice, beats]) => [voice, beats.map((beat) => spell(beat, barId))]))]));
      return { ...part, content };
    }),
  };
}

function imported(result: ImportResult): { score: ScoreJSON; report: ImportReportItem[] } {
  if (!result.ok) throw new Error(`the import failed: ${result.failure}`);
  return result;
}

/** Export a score as Guitar Pro 7 and import it again. */
function again(score: ScoreJSON): { score: ScoreJSON; report: ImportReportItem[] } {
  return imported(importScore(exportGp7(score), "again.gp"));
}

describe("the round trip of each sample: import, project, export as Guitar Pro 7, import again", () => {
  // round-trip.gp is exported from GP7_SAMPLE; to write it again after the sample changes:
  // WRITE_FIXTURES=1 pnpm vitest run tests/importExport.test.ts -t "writes"
  test.runIf(process.env.WRITE_FIXTURES === "1")("writes round-trip.gp from the sample", () => {
    writeFileSync(new URL("./fixtures/round-trip.gp", import.meta.url), exportGp7(GP7_SAMPLE));
  });

  test("GP7: the sample is read back as it was written, and stays so through another round", () => {
    const first = imported(importScore(fixture("round-trip.gp"), "round-trip.gp"));
    expect(first.report).toEqual([]);
    expect(withoutIds(first.score)).toEqual(withoutIds(GP7_SAMPLE));
    const second = again(first.score);
    expect(second.report).toEqual([]);
    expect(withoutIds(second.score)).toEqual(withoutIds(first.score));
  });

  test("GP5: the sample is read as written, its jumps and tempo name reported, and the round trip keeps it", () => {
    const first = imported(importScore(fixture("round-trip.gp5"), "round-trip.gp5"));
    expect(withoutIds(first.score)).toEqual(GP5_EXPECTED);
    expect(first.report).toEqual([
      { loss: "jump", count: 2, bars: [3, 4] },
      { loss: "tempoText", count: 1, bars: [1] },
    ]);
    const second = again(first.score);
    expect(second.report).toEqual([]);
    expect(withoutIds(second.score)).toEqual(withoutIds(spelled(first.score)));
  });

  test("MusicXML: the sample is read as written, its segno, coda and D.S. reported, and the round trip keeps it", () => {
    const first = imported(importScore(fixture("round-trip.musicxml"), "round-trip.musicxml"));
    expect(withoutIds(first.score)).toEqual(XML_EXPECTED);
    expect(first.report).toEqual([{ loss: "jump", count: 2, bars: [3, 4] }]);
    const second = again(first.score);
    expect(second.report).toEqual([]);
    expect(withoutIds(second.score)).toEqual(withoutIds(first.score));
  });

  test("a pickup bar comes back a pickup bar, as long as its longest voice", () => {
    const score: ScoreJSON = {
      schemaVersion: 1,
      title: "Pickup",
      bars: [
        { id: "a", timeSig: { numerator: 4, denominator: 4 }, tempo: 120, anacrusis: true },
        { id: "b", timeSig: { numerator: 4, denominator: 4 } },
      ],
      parts: [
        {
          id: "p",
          name: "Voice",
          kind: "pitched",
          tuning: [],
          capo: 0,
          program: 0,
          staves: [{ clef: "treble" }],
          content: {
            a: { "0:0": [{ id: "1", value: 4, dots: 0, notes: { n67: { spell: "G" } } }] },
            b: { "0:0": [{ id: "2", value: 1, dots: 0, notes: { n72: { spell: "C" } } }] },
          },
        },
      ],
    };
    expect(withoutIds(again(score).score)).toEqual(withoutIds(score));
  });
});

describe("the import report", () => {
  test("a D.S. al Coda, a segno and a coda are listed with their bars, and the score is made without them", () => {
    const { score, report } = imported(importScore(fixture("round-trip.musicxml"), "round-trip.musicxml"));
    expect(report.find((item) => item.loss === "jump")).toEqual({ loss: "jump", count: 2, bars: [3, 4] });
    expect(score.bars).toHaveLength(4);
  });

  test("a title too long is cut to 100 characters and reported; a file with none takes its file name", () => {
    const long = imported(importScore(musicXml({ title: "x".repeat(120) }), "song.musicxml"));
    expect(long.score.title).toBe("x".repeat(100));
    expect(long.report).toContainEqual({ loss: "titleTruncated", count: 1, bars: [] });
    expect(imported(importScore(musicXml({}), "My Song.musicxml")).score.title).toBe("My Song");
  });

  test("a grace note, a third staff, a third voice and a fermata are left out and reported", () => {
    const notes = `
      <note><grace/><pitch><step>D</step><octave>5</octave></pitch><voice>1</voice><type>eighth</type><staff>1</staff></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type><staff>1</staff>
        <notations><fermata/></notations></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>16</duration><voice>3</voice><type>whole</type><staff>1</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>16</duration><voice>5</voice><type>whole</type><staff>2</staff></note>
      <backup><duration>16</duration></backup>
      <note><pitch><step>C</step><octave>2</octave></pitch><duration>16</duration><voice>9</voice><type>whole</type><staff>3</staff></note>`;
    const { score, report } = imported(importScore(musicXml({ staves: 3, notes }), "piano.musicxml"));
    const losses = report.map((item) => item.loss);
    expect(losses).toEqual(expect.arrayContaining(["grace", "staves", "voices", "fermata"]));
    const [piano] = score.parts;
    expect(piano?.staves).toEqual([{ clef: "treble" }, { clef: "bass" }]);
    const [bar] = Object.values(piano!.content);
    expect(Object.keys(bar!).sort()).toEqual(["0:0", "0:1", "1:0"]);
    expect(bar!["0:0"]!.map((beat) => Object.keys(beat.notes))).toEqual([["n72"]]);
  });

  test("ppp and fff are read as pp and ff; a lyric on a part that is not pitched is reported, not kept", () => {
    const notes = `
      <direction><direction-type><dynamics><ppp/></dynamics></direction-type></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>half</type>
        <lyric number="1"><text>la</text></lyric><lyric number="2"><text>li</text></lyric></note>
      <direction><direction-type><dynamics><fff/></dynamics></direction-type></direction>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>8</duration><voice>1</voice><type>half</type></note>`;
    const { score, report } = imported(importScore(musicXml({ notes }), "song.musicxml"));
    const beats = Object.values(score.parts[0]!.content)[0]!["0:0"]!;
    expect(beats.map((beat) => [beat.dynamic, beat.lyric])).toEqual([
      ["pp", "la"],
      ["ff", undefined],
    ]);
    expect(report).toContainEqual({ loss: "lyricLines", count: 1, bars: [1] });
  });
});

describe("what parts and bars are read as", () => {
  const bar = { id: "b", timeSig: { numerator: 4, denominator: 4 }, tempo: 120 } as const;
  const guitar = (tuning: number[], program = 25): PartJSON => ({
    id: "g",
    name: "Guitar",
    kind: "fretted",
    tuning,
    capo: 0,
    program,
    staves: [{ clef: "tab" }],
    content: { b: { "0:0": [{ id: "1", value: 1, dots: 0, notes: { s1: { fret: 3 } } }] } },
  });
  const drums: PartJSON = { id: "d", name: "Drums", kind: "percussion", tuning: [], capo: 0, program: 0, staves: [{ clef: "neutral" }], content: { b: { "0:0": [] } } };

  test("the key of a bar is that of the first staff that is not a drum staff, which has none", () => {
    const score: ScoreJSON = { schemaVersion: 1, title: "Key", bars: [{ ...bar, keySig: { fifths: 3, mode: "minor" } }], parts: [drums, guitar([64, 59, 55, 50, 45, 40])] };
    // A Guitar Pro 7 file has one key a bar: the export writes it on the drum staff too.
    expect(again(score).score.bars[0]?.keySig).toEqual({ fifths: 3, mode: "minor" });
    // MusicXML has a key a part: the drums' is not read.
    const rest = `<note><rest/><duration>16</duration><voice>1</voice></note>`;
    const part = (clef: string, fifths: number) =>
      `<measure number="1"><attributes><divisions>4</divisions><key><fifths>${fifths}</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef>${clef}</clef></attributes>${rest}</measure>`;
    const xml = xmlOf("Key", [part("<sign>percussion</sign>", -2), part("<sign>G</sign><line>2</line>", 3)]);
    const read = imported(importScore(xml, "key.musicxml")).score;
    expect(read.parts.map((item) => item.kind)).toEqual(["percussion", "pitched"]);
    expect(read.bars[0]?.keySig).toEqual({ fifths: 3, mode: "major" });
  });

  test("a part with strings outside 4 to 7 is read as pitched, its notes at their pitch, and reported", () => {
    // The projection draws whatever tuning it is given; the score itself has 4 to 7 strings only.
    const score: ScoreJSON = { schemaVersion: 1, title: "Strings", bars: [bar], parts: [guitar([50, 45, 40])] };
    const { score: read, report } = again(score);
    expect(read.parts[0]).toMatchObject({ kind: "pitched", tuning: [], staves: [{ clef: "treble" }] });
    expect(Object.keys(Object.values(read.parts[0]!.content)[0]!["0:0"]![0]!.notes)).toEqual(["n53"]);
    expect(report).toContainEqual({ loss: "strings", count: 1, bars: [] });
  });

  test("a guitar or a bass shown as notes only is read as pitched and reported; a piano so shown is not", () => {
    const settings = new alphaTab.Settings();
    const bytesOf = (program: number) => {
      const { score } = projectScore({ schemaVersion: 1, title: "Notes", bars: [bar], parts: [guitar([64, 59, 55, 50, 45, 40], program)] }, settings);
      const staff = score.tracks[0]!.staves[0]!;
      staff.showTablature = false;
      staff.showStandardNotation = true;
      return new alphaTab.exporter.Gp7Exporter().export(score, settings);
    };
    const shown = imported(importScore(bytesOf(25), "guitar.gp"));
    expect(shown.score.parts[0]?.kind).toBe("pitched");
    expect(shown.report).toEqual([{ loss: "tablatureHidden", count: 1, bars: [] }]);
    expect(imported(importScore(bytesOf(0), "piano.gp")).report).toEqual([]);
  });
});

describe("limits: a file over one makes no score, and says which", () => {
  const bar = (id: string) => ({ id, timeSig: { numerator: 4, denominator: 4 } as const });
  const part = (id: string, kind: "fretted" | "percussion"): PartJSON =>
    kind === "fretted"
      ? { id, name: id, kind, tuning: [64, 59, 55, 50, 45, 40], capo: 0, program: 25, staves: [{ clef: "tab" }], content: {} }
      : { id, name: id, kind, tuning: [], capo: 0, program: 0, staves: [{ clef: "neutral" }], content: {} };
  const score = (bars: number, parts: PartJSON[]): ScoreJSON => ({ schemaVersion: 1, title: "Big", bars: Array.from({ length: bars }, (_, index) => bar(`b${index}`)), parts });

  test(`more than ${MAX_PARTS} parts`, () => {
    const drums = Array.from({ length: MAX_PARTS + 1 }, (_, index) => part(`d${index}`, "percussion"));
    expect(importScore(exportGp7(score(1, drums)), "big.gp")).toEqual({ ok: false, failure: "tooManyParts" });
  });

  test(`more than ${MAX_NON_PERCUSSION_PARTS} parts that are not drums`, () => {
    const guitars = Array.from({ length: MAX_NON_PERCUSSION_PARTS + 1 }, (_, index) => part(`g${index}`, "fretted"));
    expect(importScore(exportGp7(score(1, guitars)), "big.gp")).toEqual({ ok: false, failure: "tooManyNonDrumParts" });
  });

  test(`at the limits: ${MAX_PARTS} parts, ${MAX_NON_PERCUSSION_PARTS} of them not drums; or ${MAX_PARTS} drums`, () => {
    const guitars = Array.from({ length: MAX_NON_PERCUSSION_PARTS }, (_, index) => part(`g${index}`, "fretted"));
    const band = imported(importScore(exportGp7(score(1, [...guitars, part("d", "percussion")])), "band.gp")).score;
    expect(band.parts.map((item) => item.kind)).toEqual([...guitars.map(() => "fretted"), "percussion"]);
    const drums = Array.from({ length: MAX_PARTS }, (_, index) => part(`d${index}`, "percussion"));
    expect(imported(importScore(exportGp7(score(1, drums)), "drums.gp")).score.parts).toHaveLength(MAX_PARTS);
  });

  test(`more than ${MAX_BARS} bars`, () => {
    expect(importScore(exportGp7(score(MAX_BARS + 1, [part("g", "fretted")])), "long.gp")).toEqual({ ok: false, failure: "tooManyBars" });
    expect(imported(importScore(exportGp7(score(MAX_BARS, [part("g", "fretted")])), "long.gp")).score.bars).toHaveLength(MAX_BARS);
  });

  test(`more than ${MAX_IMPORT_BYTES} bytes of JSON`, () => {
    // Every beat of every bar written over with the longest text a beat may have.
    const text = "x".repeat(64);
    const notes = Array.from({ length: 16 }, () => `<note><rest/><duration>1</duration><voice>1</voice><type>16th</type></note>`).join("");
    const words = `<direction><direction-type><words>${text}</words></direction-type></direction>`;
    const measures = Array.from({ length: 1000 }, (_, index) => `<measure number="${index + 1}">${index === 0 ? ATTRIBUTES(1) : ""}${Array.from({ length: 16 }, () => words + notes.slice(0, notes.length / 16)).join("")}</measure>`).join("");
    const result = importScore(xmlOf("Words", Array.from({ length: 4 }, () => measures)), "words.musicxml");
    expect(result).toEqual({ ok: false, failure: "tooLarge" });
  });

  test("a file over 20 MB is not read; one alphaTab cannot read makes no score", () => {
    expect(importScore(new Uint8Array(MAX_IMPORT_FILE_BYTES + 1), "huge.gp")).toEqual({ ok: false, failure: "fileTooLarge" });
    expect(importScore(new TextEncoder().encode("not a score"), "notes.txt")).toEqual({ ok: false, failure: "unreadable" });
  });
});

/** Note on and off events of a standard MIDI file: kind, tick, channel, key, velocity. */
function notesOfMidiFile(bytes: Uint8Array): [string, number, number, number, number][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  expect(text(0)).toBe("MThd");
  const tracks = view.getUint16(10);
  const events: [string, number, number, number, number][] = [];
  let at = 8 + view.getUint32(4);
  for (let track = 0; track < tracks; track++) {
    expect(text(at)).toBe("MTrk");
    const end = at + 8 + view.getUint32(at + 4);
    at += 8;
    let tick = 0;
    let status = 0;
    const variable = () => {
      let value = 0;
      let byte: number;
      do {
        byte = bytes[at++] as number;
        value = (value << 7) | (byte & 0x7f);
      } while (byte & 0x80);
      return value;
    };
    while (at < end) {
      tick += variable();
      if ((bytes[at] as number) & 0x80) status = bytes[at++] as number;
      if (status === 0xff || status === 0xf0 || status === 0xf7) {
        // A meta event has its type first; then the length of the data, and the data.
        if (status === 0xff) at += 1;
        const length = variable();
        at += length;
      } else {
        const kind = status & 0xf0;
        const data = kind === 0xc0 || kind === 0xd0 ? 1 : 2;
        const [key, velocity] = [bytes[at] as number, bytes[at + 1] as number];
        if (kind === 0x90 && velocity > 0) events.push(["on", tick, status & 0x0f, key, velocity]);
        else if (kind === 0x80 || kind === 0x90) events.push(["off", tick, status & 0x0f, key, velocity]);
        at += data;
      }
    }
  }
  return events.sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || a[0].localeCompare(b[0]));
}

describe("MIDI export", () => {
  test("a standard MIDI file with the notes the player plays: alphaTab's generator over the same projection", () => {
    // What the player loads (`loadMidiForScore`): the generator's output for alphaTab's own synth.
    const settings = new alphaTab.Settings();
    const file = new alphaTab.midi.MidiFile();
    new alphaTab.midi.MidiFileGenerator(projectScore(GP7_SAMPLE, settings).score, settings, new alphaTab.midi.AlphaSynthMidiFileHandler(file)).generate();
    const played = file.events
      .filter((event): event is alphaTab.midi.NoteEvent => event instanceof alphaTab.midi.NoteOnEvent || event instanceof alphaTab.midi.NoteOffEvent)
      .map((event): [string, number, number, number, number] => [event instanceof alphaTab.midi.NoteOnEvent ? "on" : "off", event.tick, event.channel, event.noteKey, event.noteVelocity])
      .sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || a[0].localeCompare(b[0]));
    const exported = notesOfMidiFile(exportMidi(GP7_SAMPLE));
    expect(played.length).toBeGreaterThan(20);
    expect(exported).toEqual(played);
  });

  test("a score with no bars or no parts is a MIDI file with no notes", () => {
    const empty: ScoreJSON = { schemaVersion: 1, title: "Empty", bars: [], parts: [] };
    expect(notesOfMidiFile(exportMidi(empty))).toEqual([]);
    expect(notesOfMidiFile(exportMidi({ ...GP7_SAMPLE, parts: [] }))).toEqual([]);
  });
});

// Small MusicXML files for the report tests -------------------------------------------------------

const ATTRIBUTES = (staves: number) =>
  `<attributes><divisions>4</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time>` +
  (staves > 1 ? `<staves>${staves}</staves>` : "") +
  Array.from({ length: staves }, (_, index) => `<clef number="${index + 1}"><sign>${index === 1 ? "F" : "G"}</sign><line>${index === 1 ? 4 : 2}</line></clef>`).join("") +
  `</attributes>`;

function xmlOf(title: string | undefined, parts: string[]): Uint8Array {
  const list = parts.map((_, index) => `<score-part id="P${index + 1}"><part-name>Part ${index + 1}</part-name></score-part>`).join("");
  const body = parts.map((measures, index) => `<part id="P${index + 1}">${measures}</part>`).join("");
  const work = title === undefined ? "" : `<work><work-title>${title}</work-title></work>`;
  return new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0">${work}<part-list>${list}</part-list>${body}</score-partwise>`);
}

/** One part of one bar of 4/4, its notes as given (a whole rest by default). */
function musicXml({ title, staves = 1, notes = `<note><rest/><duration>16</duration><voice>1</voice></note>` }: { title?: string; staves?: number; notes?: string }): Uint8Array {
  return xmlOf(title, [`<measure number="1">${ATTRIBUTES(staves)}${notes}</measure>`]);
}

// What the GP5 and MusicXML samples are read as -------------------------------------------------

const C4 = { numerator: 4, denominator: 4 } as const;
const C3 = { numerator: 3, denominator: 4 } as const;
const t3 = { actual: 3, normal: 2 } as const;

/** The beats of a voice as the tests compare them: no ids. */
type Beats = Omit<BeatJSON, "id">[];

const GP5_EXPECTED = {
  schemaVersion: 1,
  title: "Round Trip GP5",
  artist: "Studio Band",
  bars: [
    { id: "bar 1", timeSig: C4, tempo: 110, keySig: { fifths: 1, mode: "major" }, repeatStart: true, section: "Intro" },
    { id: "bar 2", timeSig: C4, repeatEnd: 2, voltas: [1] },
    { id: "bar 3", timeSig: C4, voltas: [2] },
    { id: "bar 4", timeSig: C3, tempo: 140, keySig: { fifths: -1, mode: "minor" } },
  ],
  parts: [
    {
      id: "part 1",
      name: "Guitar",
      kind: "fretted",
      tuning: [64, 59, 55, 50, 45, 40],
      capo: 2,
      program: 27,
      staves: [{ clef: "tab" }],
      content: {
        "bar 1": {
          "0:0": [
            { value: 4, dots: 0, dynamic: "mp", text: "Am", notes: { s1: { fret: 5, legato: true } } },
            { value: 4, dots: 0, stroke: "down", notes: { s1: { fret: 7, slideOut: "shift" } } },
            { value: 8, dots: 1, notes: { s1: { fret: 9, bend: { type: "bendRelease", semitones: 2 }, vibrato: true } } },
            { value: 16, dots: 0, notes: { s2: { fret: 12, harmonic: "natural" }, s3: { fret: 3, dead: true } } },
            { value: 8, dots: 0, tuplet: t3, notes: { s6: { fret: 0, accent: true, palmMute: true } } },
            { value: 8, dots: 0, tuplet: t3, notes: { s6: { fret: 0, ghost: true, staccato: true, letRing: true } } },
            { value: 8, dots: 0, tuplet: t3, notes: { s5: { fret: 2, tap: true } } },
          ] satisfies Beats,
        },
        "bar 2": { "0:0": [{ value: 1, dots: 0, notes: { s5: { fret: 2, tie: true } } }] },
        "bar 3": {
          "0:0": [
            { value: 2, dots: 1, stroke: "up", dynamic: "f", notes: { s4: { fret: 3, slideOut: "outDown", harmonic: "artificial" } } },
            { value: 4, dots: 0, notes: {} },
          ],
        },
        "bar 4": { "0:0": [{ value: 2, dots: 1, notes: { s1: { fret: 0 } } }] },
      },
    },
    {
      id: "part 2",
      name: "Drums",
      kind: "percussion",
      tuning: [],
      capo: 0,
      program: 0,
      staves: [{ clef: "neutral" }],
      content: {
        "bar 1": {
          "0:0": [
            { value: 2, dots: 0, notes: { p42: {}, p38: { ghost: true } } },
            { value: 2, dots: 0, notes: { p46: { accent: true } } },
          ],
          "0:1": [{ value: 1, dots: 0, notes: { p36: {} } }],
        },
        "bar 2": { "0:0": [{ value: 1, dots: 0, notes: { p38: {} } }] },
        "bar 3": { "0:0": [] },
        "bar 4": { "0:0": [{ value: 2, dots: 1, notes: { p36: {} } }] },
      },
    },
    {
      id: "part 3",
      name: "Piano",
      kind: "pitched",
      tuning: [],
      capo: 0,
      program: 0,
      staves: [{ clef: "treble" }],
      content: {
        "bar 1": {
          "0:0": [
            { value: 4, dots: 0, lyric: "Hel-", notes: { n72: {}, n67: {} } },
            { value: 4, dots: 0, lyric: "lo", notes: { n69: {} } },
            { value: 4, dots: 0, lyric: "world", notes: { n70: { staccato: true } } },
            { value: 4, dots: 0, lyric: "oh", notes: { n66: { accent: true } } },
          ],
        },
        "bar 2": {
          "0:0": [
            { value: 2, dots: 0, notes: { n64: {} } },
            { value: 2, dots: 0, notes: { n64: { tie: true } } },
          ],
        },
        "bar 3": { "0:0": [{ value: 1, dots: 0, notes: { n74: {} } }] },
        "bar 4": { "0:0": [{ value: 2, dots: 1, notes: { n67: {} } }] },
      },
    },
  ],
};

const XML_EXPECTED = {
  schemaVersion: 1,
  title: "Round Trip XML",
  artist: "Studio Band",
  bars: [
    { id: "bar 1", timeSig: C4, tempo: 100, keySig: { fifths: 1, mode: "major" }, repeatStart: true, section: "Verse" },
    { id: "bar 2", timeSig: C4, repeatEnd: 2, voltas: [1] },
    { id: "bar 3", timeSig: C4, voltas: [2] },
    { id: "bar 4", timeSig: C3 },
  ],
  parts: [
    {
      id: "part 1",
      name: "Voice",
      kind: "pitched",
      tuning: [],
      capo: 0,
      // MusicXML counts programs from 1.
      program: 53,
      staves: [{ clef: "treble" }],
      content: {
        "bar 1": {
          "0:0": [
            // MusicXML says a syllable goes on (`begin`) apart from its text: alphaTab keeps the text only.
            { value: 4, dots: 0, dynamic: "mp", lyric: "Hel", notes: { n67: { spell: "G" } } },
            { value: 4, dots: 0, lyric: "lo", notes: { n69: { spell: "A" } } },
            { value: 4, dots: 0, lyric: "world", notes: { n70: { staccato: true, spell: "Bb" } } },
            { value: 4, dots: 0, notes: { n66: { accent: true, spell: "F#" } } },
          ],
        },
        "bar 2": {
          "0:0": [
            { value: 2, dots: 0, lyric: "oh", notes: { n64: { spell: "E" } } },
            { value: 2, dots: 0, notes: { n64: { tie: true, spell: "E" } } },
          ],
        },
        "bar 3": {
          "0:0": [
            { value: 8, dots: 0, tuplet: t3, notes: { n74: { spell: "D" } } },
            { value: 8, dots: 0, tuplet: t3, notes: { n72: { spell: "C" } } },
            { value: 8, dots: 0, tuplet: t3, notes: { n71: { spell: "B" } } },
            { value: 8, dots: 0, notes: {} },
            { value: 4, dots: 1, notes: { n67: { spell: "G" } } },
            { value: 4, dots: 0, notes: { n69: { spell: "A" } } },
          ],
        },
        "bar 4": { "0:0": [{ value: 2, dots: 1, notes: { n67: { spell: "G" } } }] },
      },
    },
    {
      id: "part 2",
      name: "Guitar",
      kind: "fretted",
      tuning: [64, 59, 55, 50, 45, 40],
      capo: 0,
      program: 25,
      staves: [{ clef: "tab" }],
      content: {
        "bar 1": {
          "0:0": [
            { value: 4, dots: 0, notes: { s3: { fret: 2, legato: true } } },
            { value: 4, dots: 0, notes: { s3: { fret: 4 } } },
            { value: 2, dots: 0, notes: { s6: { fret: 0, staccato: true }, s5: { fret: 2 } } },
          ],
        },
        "bar 2": { "0:0": [{ value: 1, dots: 0, notes: { s1: { fret: 0 } } }] },
        "bar 3": { "0:0": [{ value: 1, dots: 0, notes: { s2: { fret: 3, accent: true } } }] },
        "bar 4": { "0:0": [{ value: 2, dots: 1, notes: { s3: { fret: 0 } } }] },
      },
    },
    {
      id: "part 3",
      name: "Drums",
      kind: "percussion",
      tuning: [],
      capo: 0,
      program: 0,
      staves: [{ clef: "neutral" }],
      content: {
        "bar 1": {
          "0:0": [
            { value: 2, dots: 0, notes: { p42: {}, p38: {} } },
            { value: 2, dots: 0, notes: { p42: {} } },
          ],
          "0:1": [{ value: 1, dots: 0, notes: { p36: {} } }],
        },
        "bar 2": { "0:0": [{ value: 1, dots: 0, notes: { p38: {} } }] },
        "bar 3": { "0:0": [] },
        "bar 4": { "0:0": [{ value: 2, dots: 1, notes: { p36: {} } }] },
      },
    },
  ],
};
