// M3, the cursor geometry (#47; docs/spec/testing.md, section 5, check 6): where the cursor is
// drawn on the two staves of a piano and in the second voice, measured as S3 was on one staff,
// against where alphaTab reports it drew the note heads.
import { expect, type Page, test } from "@playwright/test";
import type { NoteHead, Rect } from "@studio/score-render";

import { logInAsAdmin, openEditView, placeCursor } from "./editView";
import { environment, screenshotPath, writeData } from "./output";
import { STAVES_VOICES, stavesScore } from "./scores";

// Twice the pixels, so that the cursor and the note heads can be told apart on the screenshots.
test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 720 } });

const centreOf = (rect: Rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
const round = (value: number) => Math.round(value * 1000) / 1000;

/** Put the cursor on a beat of the first bar (-1: the append slot of the second bar's empty voice) and read where it and the note heads are drawn. */
async function measureAt(page: Page, part: number, beat: number, line: number, voice: string): Promise<{ rect: Rect; heads: NoteHead[] }> {
  await placeCursor(page, part, beat < 0 ? 1 : 0, beat, line, voice);
  const { rect, heads } = await page.evaluate(() => ({ rect: window.__studioMeasure!.cursorRect(), heads: window.__studioMeasure!.noteHeads() }));
  expect(rect, `${part} ${voice} ${beat} ${line}`).not.toBeNull();
  return { rect: rect!, heads };
}

test("M3: the cursor on both staves of a piano and in the second voice, against the note heads alphaTab drew", async ({ page }) => {
  await logInAsAdmin(page);
  await openEditView(page, stavesScore());
  await page.waitForTimeout(600); // the pieces on screen are painted just after the layout

  // On each note: the cursor on the note's staff position, and its note head.
  const notes: Record<string, unknown>[] = [];
  /** Where the note heads of each staff are drawn, by staff position: `part staff` → position → y. */
  const drawnAt = new Map<string, Map<number, number>>();
  for (const { part, voice, notes: pitches } of STAVES_VOICES) {
    for (const [beat, [pitch, position]] of pitches.entries()) {
      const { rect, heads } = await measureAt(page, part, beat, position, voice);
      expect(heads.map((head) => head.key), `${voice} n${pitch}`).toEqual([`n${pitch}`]);
      const cursor = centreOf(rect);
      const head = centreOf(heads[0]!.rect);
      notes.push({ part, voice, beat, pitch, position, cursor: rect, head: heads[0]!.rect, dx: round(cursor.x - head.x), dy: round(cursor.y - head.y) });
      const staff = `${part} ${voice[0]}`;
      if (!drawnAt.has(staff)) drawnAt.set(staff, new Map());
      drawnAt.get(staff)!.set(position, head.y);
    }
  }

  // On a position with no note on the cursor's beat: the cursor against a note head drawn on that line or space elsewhere in the staff.
  const empty: Record<string, unknown>[] = [];
  for (const { part, voice, notes: pitches } of STAVES_VOICES) {
    for (const [beat, [, own]] of pitches.entries()) {
      for (const [position, y] of drawnAt.get(`${part} ${voice[0]}`)!) {
        if (position === own) continue;
        const { rect } = await measureAt(page, part, beat, position, voice);
        empty.push({ part, voice, beat, position, dy: round(centreOf(rect).y - y) });
      }
    }
  }

  // The append slot of each empty voice of the second bar, on the middle line: on its own staff.
  const slots: Record<string, unknown>[] = [];
  for (const voice of ["0:0", "0:1", "1:0", "1:1"]) {
    const { rect } = await measureAt(page, 0, -1, 4, voice);
    slots.push({ voice, rect });
  }

  const largest = (rows: Record<string, unknown>[], key: string) => Math.max(...rows.map((row) => Math.abs(row[key] as number)));
  const summary = { notes: notes.length, maxDx: largest(notes, "dx"), maxDy: largest(notes, "dy"), emptyPositions: empty.length, maxEmptyDy: largest(empty, "dy") };
  writeData("m3-cursor-geometry.json", { environment: await environment(page), summary, notes, empty, slots });

  // Screenshots: the second staff, the second voice, a space of the second staff with no note, the
  // treble clef an octave down, and the append slot of an empty second voice.
  const top = (await page.locator("[data-scroller]").boundingBox())!.y;
  const shots: [name: string, part: number, beat: number, line: number, voice: string][] = [
    ["m3-second-staff", 0, 1, 9, "1:0"],
    ["m3-second-voice", 0, 1, 9, "0:1"],
    ["m3-second-staff-empty-space", 0, 1, 3, "1:0"],
    ["m3-second-staff-second-voice", 0, 1, 5, "1:1"],
    ["m3-treble-8vb", 1, 0, 1, "0:0"],
    ["m3-empty-second-voice", 0, -1, 4, "0:1"],
  ];
  for (const [name, part, beat, line, voice] of shots) {
    await measureAt(page, part, beat, line, voice);
    await page.waitForTimeout(100);
    await page.screenshot({ path: screenshotPath(`${name}.png`), clip: { x: 0, y: top, width: 1280, height: 420 } });
  }

  expect(summary.maxDx).toBeLessThanOrEqual(1);
  expect(summary.maxDy).toBeLessThanOrEqual(1);
  expect(summary.maxEmptyDy).toBeLessThanOrEqual(1);
});
