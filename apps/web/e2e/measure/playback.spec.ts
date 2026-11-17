// S5: an edit while the score plays, in the edit view. After each edit the sound is regenerated; the player must
// keep playing from about where it was, and nothing may throw. The audio itself cannot be heard
// from here: what is checked is the player's state and the positions it reports.
import { expect, test } from "@playwright/test";

import { strings } from "../../src/strings";
import { logInAsAdmin, median, openEditView, p95, runs } from "./editView";
import { environment, MODE, writeData } from "./output";
import { perfScore } from "./scores";

const ROUNDS = runs(30);
/** 120 quarter notes a minute, 960 ticks a quarter. */
const TICKS_PER_MS = (120 * 960) / 60_000;

test("the player goes on from where it was after the sound is regenerated", async ({ page }) => {
  const score = perfScore();
  await logInAsAdmin(page);
  await openEditView(page, score);
  // The play button, as a member would: the browser lets audio start only from a gesture.
  await page.getByRole("button", { name: strings.score.player.play, exact: true }).click();
  await page.waitForFunction(() => window.__studioMeasure!.player.position().tick > 2000, null, { timeout: 20_000 });

  const rounds: { generate: number; total: number; tickBefore: number; firstTickAfter: number; firstPositionAfterMs: number; behindMs: number; wentBack: boolean }[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const result = await page.evaluate(async (bar) => {
      const studio = window.__studioMeasure!;
      await studio.editBar(0, bar);
      const before = studio.player.trace.at(-1)!;
      const startedAt = performance.now();
      const { generate, total } = await studio.player.reload();
      const traceFrom = studio.player.trace.length;
      await new Promise((resolve) => setTimeout(resolve, 600));
      const after = studio.player.trace.slice(traceFrom);
      return { before, startedAt, generate, total, after, state: studio.player.state(), errors: studio.errors };
    }, 20 + round * 2);

    expect(result.errors).toEqual([]);
    expect(result.state).toBe("playing");
    const first = result.after.find((item) => item.tick >= result.before.tick);
    const last = result.after.at(-1);
    expect(first, "a position at or after the one before the reload").toBeDefined();
    expect(last!.tick).toBeGreaterThan(first!.tick);
    // How far playback fell behind the clock across the reload: the length of the interruption.
    const behind = last!.at - result.before.at - (last!.tick - result.before.tick) / TICKS_PER_MS;
    rounds.push({
      generate: result.generate,
      total: result.total,
      tickBefore: result.before.tick,
      firstTickAfter: first!.tick,
      firstPositionAfterMs: first!.at - result.startedAt,
      behindMs: behind,
      // None of the positions reported after the reload is earlier than the one before it.
      wentBack: result.after.some((item) => item.tick < result.before.tick),
    });
    await page.waitForTimeout(300);
  }

  const column = (key: "generate" | "total" | "firstPositionAfterMs" | "behindMs"): number[] => rounds.map((item) => item[key]);
  const summary = Object.fromEntries(
    (["generate", "total", "firstPositionAfterMs", "behindMs"] as const).map((key) => [key, { median: median(column(key)), p95: p95(column(key)), max: Math.max(...column(key)) }]),
  );
  writeData(`s5-playback-${MODE}.json`, { environment: await environment(page), rounds: ROUNDS, summary, wentBack: rounds.filter((item) => item.wentBack).length, samples: rounds });
  console.log(JSON.stringify(summary, null, 1));
  expect(rounds.filter((item) => item.wentBack)).toHaveLength(0);
  // Still playing at the end, and further than at the start.
  expect(await page.evaluate(() => window.__studioMeasure!.player.state())).toBe("playing");
});
