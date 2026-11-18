// A note of a staff is drawn on the position the editor finds it on (score-model's `lineOfPitch`,
// docs/spec/schema.md 8.1): by its spelling, natural on a white key, whatever the key prefers
// (alphaTab spells a white key E♯ or C♭ in a key of six or seven sharps or flats when left to
// itself). Laid out with alphaTab in Node, as geometry.test.ts does.
import * as alphaTab from "@coderline/alphatab";
import { addPart, createScore, type Cursor, cursorAt, docToJson, insertBars, insertBeat, type KeySignature, lineOfPitch, type NoteJSON, type ScoreJSON, setKeySig, setNote } from "@studio/score-model";
import { expect, test } from "vitest";
import * as Y from "yjs";

import { cursorRect, noteHeads, type PartShape, type StaffMetrics } from "../src/geometry";
import { projectScore } from "../src/projection";

/** Lay a score out as the edit view does (Page layout, 1200 px wide). */
function layOut(score: ScoreJSON) {
  const settings = new alphaTab.Settings();
  settings.core.engine = "svg";
  settings.core.includeNoteBounds = true;
  settings.display.layoutMode = alphaTab.LayoutMode.Page;
  const projection = projectScore(score, settings);
  const renderer = new alphaTab.rendering.ScoreRenderer(settings);
  renderer.width = 1200;
  renderer.renderScore(projection.score, score.parts.map((_, index) => index));
  const engraving = settings.display.resources.engravingSettings;
  const metrics: StaffMetrics = { staffSpace: engraving.oneStaffSpace, tabLineSpacing: engraving.tabLineSpacing, lineThickness: engraving.staffLineThickness };
  const parts = new Map<string, PartShape>(score.parts.map((part) => [part.id, { kind: part.kind, strings: part.tuning.length }]));
  const lookup = renderer.boundsLookup!;
  return { rect: (cursor: Cursor) => cursorRect(lookup, projection, parts, cursor, metrics), heads: (cursor: Cursor) => noteHeads(lookup, projection, parts, cursor) };
}

/** A treble staff of one bar in `keySig`, a quarter for each note: its pitch, its stored note, the beat it is on. */
function staffOf(keySig: KeySignature, notes: [pitch: number, note: NoteJSON][]) {
  const doc = new Y.Doc();
  createScore(doc, "Keys");
  const [barId] = insertBars(doc, { after: null, count: 1 });
  const partId = addPart(doc, { name: "Keys", kind: "pitched" });
  let cursor = cursorAt(doc, partId, barId!);
  setKeySig(doc, cursor, keySig);
  const beats = notes.map(([pitch, note]) => {
    cursor = setNote(doc, insertBeat(doc, { ...cursor, at: "after" }, { value: 4 }), `n${pitch}`, note);
    return { pitch, note, beat: cursor };
  });
  return { beats, drawn: layOut(docToJson(doc)) };
}

test.each([
  ["seven sharps", { fifths: 7, mode: "major" }, [65, 60]],
  ["six sharps", { fifths: 6, mode: "major" }, [65]],
  ["seven flats", { fifths: -7, mode: "major" }, [71, 64]],
  ["six flats", { fifths: -6, mode: "major" }, [71]],
] as const)("in a key of %s, a white key spelled natural, or not spelled, is drawn on its own letter's position, as the editor finds it", (_, keySig, pitches) => {
  const notes = pitches.flatMap((pitch): [number, NoteJSON][] => [
    [pitch, { spell: lineLetter(pitch) }],
    [pitch, {}],
  ]);
  const { beats, drawn } = staffOf(keySig, notes);
  for (const { pitch, note, beat } of beats) {
    const line = lineOfPitch("treble", pitch, note.spell, keySig);
    const name = `n${pitch} ${JSON.stringify(note)}`;
    const [head] = drawn.heads(beat);
    expect(head?.key, name).toBe(`n${pitch}`);
    const centre = head!.rect.y + head!.rect.height / 2;
    const on = drawn.rect({ ...beat, line })!;
    // Nearer the cursor on its line than on either line beside it.
    for (const other of [line - 1, line + 1]) {
      const off = drawn.rect({ ...beat, line: other })!;
      expect(Math.abs(centre - (off.y + off.height / 2)), `${name}, line ${other}`).toBeGreaterThan(Math.abs(centre - (on.y + on.height / 2)));
    }
  }
});

test("F in seven sharps is on F's position, B in seven flats on B's: the positions the test above checks are those letters'", () => {
  expect(lineOfPitch("treble", 65, "F", { fifths: 7, mode: "major" })).toBe(7);
  expect(lineOfPitch("treble", 71, "B", { fifths: -7, mode: "major" })).toBe(4);
});

/** The natural spelling of a white key. */
function lineLetter(pitch: number): string {
  return ({ 0: "C", 2: "D", 4: "E", 5: "F", 7: "G", 9: "A", 11: "B" } as Record<number, string>)[pitch % 12]!;
}
