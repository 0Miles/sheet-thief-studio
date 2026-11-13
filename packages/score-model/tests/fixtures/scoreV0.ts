// A made-up schema 0, older than the first published one, for the migration tests only
// (docs/spec/schema.md section 10): its parts have no `staves`, their staves came from the
// voices their content uses. Nothing real was ever stored in it.
import * as Y from "yjs";

/** A score of schema 0 as a version holds it. */
export const SCORE_V0 = {
  schemaVersion: 0,
  title: "Old",
  bars: [
    { id: "b1", timeSig: { numerator: 4, denominator: 4 }, tempo: 100 },
    { id: "b2", timeSig: { numerator: 4, denominator: 4 } },
  ],
  parts: [
    {
      id: "gtr",
      name: "Guitar",
      kind: "fretted",
      tuning: [64, 59, 55, 50, 45, 40],
      capo: 0,
      program: 25,
      content: { b1: { "0:0": [{ id: "x1", value: 2, dots: 0, notes: { s6: { fret: 0 } } }] }, b2: { "0:0": [] } },
    },
    {
      id: "key",
      name: "Keys",
      kind: "pitched",
      tuning: [],
      capo: 0,
      program: 0,
      content: { b1: { "0:0": [{ id: "x2", value: 1, dots: 0, notes: { n60: { spell: "C" } } }] }, b2: { "0:0": [] } },
    },
  ],
};

/** The same score as a document of schema 0, written the way schema 0 wrote it. */
export function docV0(): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    doc.getMap("meta").set("schemaVersion", 0);
    doc.getMap("meta").set("title", SCORE_V0.title);
    SCORE_V0.bars.forEach(({ id, ...fields }, index) => {
      const bar = new Y.Map<unknown>();
      bar.set("order", `a${index}`);
      for (const [name, value] of Object.entries(fields)) bar.set(name, value);
      doc.getMap("bars").set(id, bar);
    });
    SCORE_V0.parts.forEach(({ id, content, ...fields }, index) => {
      const part = new Y.Map<unknown>();
      part.set("order", `a${index}`);
      for (const [name, value] of Object.entries(fields)) part.set(name, value);
      const bars = new Y.Map<unknown>();
      for (const [barId, voices] of Object.entries(content)) {
        const map = new Y.Map<unknown>();
        for (const [voice, beats] of Object.entries(voices as Record<string, { notes: Record<string, unknown> }[]>)) {
          const array = new Y.Array<unknown>();
          array.push(
            beats.map(({ notes, ...beatFields }) => {
              const beat = new Y.Map<unknown>();
              for (const [name, value] of Object.entries(beatFields)) beat.set(name, value);
              const noteMap = new Y.Map<unknown>();
              for (const [key, note] of Object.entries(notes)) noteMap.set(key, note);
              beat.set("notes", noteMap);
              return beat;
            }),
          );
          map.set(voice, array);
        }
        bars.set(barId, map);
      }
      part.set("content", bars);
      doc.getMap("parts").set(id, part);
    });
  });
  return doc;
}
