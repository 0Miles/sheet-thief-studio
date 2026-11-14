// S4, the size of the document: the Yjs state of 100 bars × 5 parts, then after 2,000 more edits.
import { test } from "@playwright/test";

import { logInAsAdmin, openEditView } from "./editView";
import { environment, writeData } from "./output";
import { perfScore } from "./scores";

test("size of the Yjs state of the 100 × 5 score, before and after 2,000 edits", async ({ page }) => {
  const scoreId = perfScore();
  await logInAsAdmin(page);
  await openEditView(page, scoreId);
  const measure = (): Promise<{ stateBytes: number; jsonBytes: number; beats: number }> =>
    page.evaluate(() => {
      const studio = window.__studioMeasure!;
      const json = studio.json();
      const beats = json.parts.reduce((sum, part) => sum + Object.values(part.content).reduce((inner, voices) => inner + Object.values(voices).reduce((n, list) => n + list.length, 0), 0), 0);
      return { stateBytes: studio.stateSize(), jsonBytes: new TextEncoder().encode(JSON.stringify(json)).byteLength, beats };
    });
  const seeded = await measure();
  await page.evaluate(() => window.__studioMeasure!.bulkEdit(2000));
  const edited = await measure();
  // In one transaction, drawn once: M0 made one transaction each, without drawing.
  const result = { environment: await environment(page), seeded, edited, edits: 2000, oneTransaction: true, growthBytesPerEdit: (edited.stateBytes - seeded.stateBytes) / 2000 };
  writeData("s4-document-size.json", result);
  console.log(JSON.stringify({ seeded, edited }, null, 1));
});
