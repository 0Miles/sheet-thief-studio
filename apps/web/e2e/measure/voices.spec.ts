// M2: the cursor on the second voice of the drums (#45), S3's way (docs/spike-report.md): on every
// beat of both voices, where the renderer puts the cursor against where alphaTab says it drew the
// note heads. Results in docs/measurements/data/m2-drum-second-voice.json, for docs/measurements.md.
import { expect, test } from "@playwright/test";
import { DRUM_PIECES } from "@studio/score-model";
import type { NoteHead, Rect } from "@studio/score-render";

import { logInAsAdmin, openEditView, placeCursor } from "./editView";
import { browserOf, screenshotPath, writeData } from "./output";
import { drumVoicesScore } from "./scores";

test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 620 } });

/** The line each drum piece is drawn on, by its key. */
const LINES = new Map(Object.values(DRUM_PIECES).map((piece) => [`p${piece.id}`, piece.line]));

/** How many beats each voice of each bar holds, as `drumVoicesScore` writes them. */
const BEATS: Record<string, number[]> = { "0:0": [8, 8, 4, 0], "0:1": [5, 0, 6, 0] };

interface Measured {
  voice: string;
  bar: number;
  beat: number;
  key: string;
  line: number;
  /** Cursor centre minus note head centre, in CSS pixels. */
  dx: number;
  /** The same, in y, with the cursor on the piece's own line. */
  dy: number;
}

test("M2: the cursor on the second voice of the drums is where alphaTab drew the note heads", async ({ page }) => {
  await logInAsAdmin(page);
  await openEditView(page, drumVoicesScore());
  const measured: Measured[] = [];
  const read = () => page.evaluate(() => [window.__studioMeasure!.cursorRect(), window.__studioMeasure!.noteHeads()] as [Rect | null, NoteHead[]]);
  for (const [voice, counts] of Object.entries(BEATS)) {
    for (const [bar, count] of counts.entries()) {
      for (let beat = 0; beat < count; beat++) {
        await placeCursor(page, 0, bar, beat, 4, voice);
        const [, heads] = await read();
        expect(heads.length, `${voice} bar ${bar + 1} beat ${beat + 1}`).toBeGreaterThan(0);
        for (const head of heads) {
          const line = LINES.get(head.key)!;
          await placeCursor(page, 0, bar, beat, line, voice);
          const [rect] = await read();
          expect(rect).not.toBeNull();
          const dx = rect!.x + rect!.width / 2 - (head.rect.x + head.rect.width / 2);
          const dy = rect!.y + rect!.height / 2 - (head.rect.y + head.rect.height / 2);
          measured.push({ voice, bar: bar + 1, beat: beat + 1, key: head.key, line, dx, dy });
        }
      }
    }
  }
  // The append slot of the empty second voice of bar 2: a caret at the start of the bar.
  await placeCursor(page, 0, 1, -1, 4, "0:1");
  const [emptySlot] = await read();
  expect(emptySlot).not.toBeNull();
  // The first system, below the header and the toolbar (rects are on alphaTab's surface, not the page).
  const system = { x: 0, y: (await page.locator("[data-scroller]").boundingBox())!.y, width: 1280, height: 330 };
  await page.screenshot({ path: screenshotPath("m2-drum-second-voice-empty-bar.png"), clip: system });
  // Bar 1, the third beat of the feet (a kick on the "and" of 2), for the report.
  await placeCursor(page, 0, 0, 2, DRUM_PIECES.kick.line, "0:1");
  await page.screenshot({ path: screenshotPath("m2-drum-second-voice.png"), clip: system });

  const worst = (voice: string, axis: "dx" | "dy") => Math.max(...measured.filter((item) => item.voice === voice).map((item) => Math.abs(item[axis])));
  const summary = { browser: browserOf(page), heads: measured.length, worst: { first: { dx: worst("0:0", "dx"), dy: worst("0:0", "dy") }, second: { dx: worst("0:1", "dx"), dy: worst("0:1", "dy") } }, emptySlot };
  writeData("m2-drum-second-voice.json", { summary, measured });
  console.log(JSON.stringify(summary));
  for (const item of measured) expect(Math.abs(item.dx), `${item.voice} bar ${item.bar} beat ${item.beat} ${item.key}`).toBeLessThanOrEqual(1);
});
