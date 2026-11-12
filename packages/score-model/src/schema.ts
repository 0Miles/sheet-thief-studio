// The Yjs shape of a score (docs/adr/0002): a global sequence of bars, and parts that hold the
// content of each bar. Readers go through docToJson; writers go through the commands.
import * as Y from "yjs";

/** Version of the document schema; a document written by a newer version opens read-only. */
export const SCHEMA_VERSION = 1;

/** Origin of the transactions made by the commands of this client: the only ones its undo follows. */
export const LOCAL = "local";

/** The first voice of the first staff: where the music of a part goes unless it has more. */
export const MAIN_VOICE = "0:0";

export type PartKind = "fretted" | "percussion" | "pitched";

/** A note value as the denominator of a whole note: 4 is a quarter, 8 an eighth. */
export type NoteValue = 1 | 2 | 4 | 8 | 16 | 32 | 64;

export interface TimeSignature {
  numerator: number;
  denominator: number;
}

/** `actual` notes in the time of `normal`: a triplet is 3 in the time of 2. */
export interface Tuplet {
  actual: number;
  normal: number;
}

export interface NoteJSON {
  /** Fretted parts: the fret on the string named by the key of the note. */
  fret?: number;
  /** Pitched parts: how the pitch is spelled when its key alone does not say ("C#", "Db"). */
  spell?: string;
  /** The note continues the one before it on the same string or pitch. */
  tie?: boolean;
  ghost?: boolean;
}

export interface BeatJSON {
  id: string;
  value: NoteValue;
  dots: 0 | 1 | 2;
  tuplet?: Tuplet;
  /** Keyed by position: "s3" a string, "p38" a drum piece, "n60" a pitch. Empty is a rest. */
  notes: Record<string, NoteJSON>;
}

export interface BarJSON {
  id: string;
  timeSig: TimeSignature;
  /** Quarter notes per minute from this bar on; absent when the tempo does not change here. */
  tempo?: number;
}

export interface PartJSON {
  id: string;
  name: string;
  kind: PartKind;
  /** Fretted parts: MIDI pitch of each open string, from the first (highest) string. */
  tuning: number[];
  capo: number;
  /** General MIDI program the part is played with. */
  program: number;
  /** Bar id, then voice ("staff:voice"), to its beats. A bar or voice left out is empty. */
  content: Record<string, Record<string, BeatJSON[]>>;
}

export interface ScoreJSON {
  schemaVersion: number;
  title: string;
  /** In score order. */
  bars: BarJSON[];
  /** In score order. */
  parts: PartJSON[];
}

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

/** Ids in score order: by ordering key, then by id, so that equal keys sort the same everywhere. */
export function ordered(map: Y.Map<Y.Map<unknown>>): string[] {
  return [...map.entries()]
    .map(([id, value]) => [value.get("order") as string, id] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([, id]) => id);
}

export function emptyBarContent(): YBarContent {
  const content: YBarContent = new Y.Map();
  content.set(MAIN_VOICE, new Y.Array<YBeat>());
  return content;
}

function beatToJson(beat: YBeat): BeatJSON {
  const tuplet = beat.get("tuplet") as Tuplet | undefined;
  return {
    id: beat.get("id") as string,
    value: beat.get("value") as NoteValue,
    dots: (beat.get("dots") as 0 | 1 | 2 | undefined) ?? 0,
    ...(tuplet ? { tuplet } : {}),
    notes: (beat.get("notes") as Y.Map<NoteJSON>).toJSON() as Record<string, NoteJSON>,
  };
}

/** The score as plain data, in score order: what versions, exports and tests read. */
export function docToJson(doc: Y.Doc): ScoreJSON {
  const bars = barsOf(doc);
  const parts = partsOf(doc);
  const barIds = ordered(bars);
  return {
    schemaVersion: (metaOf(doc).get("schemaVersion") as number | undefined) ?? SCHEMA_VERSION,
    title: (metaOf(doc).get("title") as string | undefined) ?? "",
    bars: barIds.map((id) => {
      const bar = bars.get(id) as YBar;
      const tempo = bar.get("tempo") as number | undefined;
      return { id, timeSig: bar.get("timeSig") as TimeSignature, ...(tempo === undefined ? {} : { tempo }) };
    }),
    parts: ordered(parts).map((id) => {
      const part = parts.get(id) as YPart;
      const content: PartJSON["content"] = {};
      for (const barId of barIds) {
        const voices = contentOf(part).get(barId);
        if (voices === undefined) continue; // not filled in yet: reads as an empty bar
        content[barId] = Object.fromEntries([...voices.entries()].map(([voice, beats]) => [voice, beats.map(beatToJson)]));
      }
      return {
        id,
        name: part.get("name") as string,
        kind: part.get("kind") as PartKind,
        tuning: part.get("tuning") as number[],
        capo: part.get("capo") as number,
        program: part.get("program") as number,
        content,
      };
    }),
  };
}
