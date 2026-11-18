// Writing a score given as plain data into a document: an imported score, a restored version
// (docs/spec/schema.md section 10).
import { generateNKeysBetween } from "fractional-indexing";
import * as Y from "yjs";

import {
  barsOf,
  type BeatJSON,
  LOCAL,
  metaOf,
  partsOf,
  SCHEMA_VERSION,
  scoreSchema,
  type YBar,
  type YBarContent,
  type YBeat,
  type YPart,
  voiceKeys,
} from "./schema";

/** Set every field that has a value. */
function setFields(map: Y.Map<unknown>, fields: object): void {
  for (const [field, value] of Object.entries(fields)) if (value !== undefined) map.set(field, value);
}

function beatToY({ notes, ...fields }: BeatJSON): YBeat {
  const beat: YBeat = new Y.Map();
  setFields(beat, fields);
  const map = new Y.Map();
  for (const [key, note] of Object.entries(notes)) map.set(key, note);
  beat.set("notes", map);
  return beat;
}

/**
 * Write a score into a document, in one transaction of this member's, in place of the score it
 * held as far as this document knows it (title, artist, bars and parts): the ids of the score
 * kept, the ordering keys from `orderKeys` (as many as there are bars, then parts), and every bar
 * of every part given its content with all its voices. Throws, writing nothing, when the score
 * does not pass the schema or is of another schema version (migrateJson brings an old one up to
 * date first). What `jsonToDoc` and a restore (`replaceScore`) share.
 */
export function writeScore(doc: Y.Doc, json: unknown, orderKeys: (count: number) => string[]): void {
  const score = scoreSchema.parse(json);
  if (score.schemaVersion !== SCHEMA_VERSION) throw new Error(`jsonToDoc writes schema version ${SCHEMA_VERSION}: migrate version ${score.schemaVersion} first (migrateJson)`);
  doc.transact(() => {
    const meta = metaOf(doc);
    meta.set("schemaVersion", SCHEMA_VERSION);
    meta.set("title", score.title);
    if (score.artist === undefined) meta.delete("artist");
    else meta.set("artist", score.artist);

    const bars = barsOf(doc);
    bars.clear();
    const barKeys = orderKeys(score.bars.length);
    score.bars.forEach(({ id, ...fields }, index) => {
      const bar: YBar = new Y.Map();
      bar.set("order", barKeys[index]);
      setFields(bar, fields);
      bars.set(id, bar);
    });

    const parts = partsOf(doc);
    parts.clear();
    const partKeys = orderKeys(score.parts.length);
    score.parts.forEach(({ id, content: beatsByBar, ...fields }, index) => {
      const part: YPart = new Y.Map();
      part.set("order", partKeys[index]);
      setFields(part, fields);
      const content = new Y.Map<YBarContent>();
      for (const { id: barId } of score.bars) {
        // Every voice of every staff, filled before it joins the document (a map not in a document yet cannot be read).
        const voices: YBarContent = new Y.Map();
        for (const voice of voiceKeys(fields.staves.length)) {
          const beats = new Y.Array<YBeat>();
          beats.push((beatsByBar[barId]?.[voice] ?? []).map(beatToY));
          voices.set(voice, beats);
        }
        content.set(barId, voices);
      }
      part.set("content", content);
      parts.set(id, part);
    });
  }, LOCAL);
}

/**
 * Write a score into a document (`writeScore`): a new document when none is given, an imported
 * score. The ordering keys are made from nothing, in order, without a suffix
 * (docs/spec/schema.md, section 1).
 */
export function jsonToDoc(json: unknown, doc: Y.Doc = new Y.Doc()): Y.Doc {
  writeScore(doc, json, (count) => generateNKeysBetween(null, null, count));
  return doc;
}
