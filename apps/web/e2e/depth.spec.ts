// A tab whose document holds a value nested deeper than a value of the document may be (#102;
// docs/spec/collab.md, sections 2.1 and 9; docs/spec/views.md, section 10). The server refuses
// it and says so; the tab stops connecting, which it would otherwise do every second with a new
// ticket, says why, and opens the score anew from the server when asked, dropping what it held.
import { MAX_VALUE_DEPTH } from "@studio/score-model";

import { strings } from "../src/strings";
import { ADMIN } from "./environment";
import { beatsIn, drawn, loggedIn, openScore, pageErrors, scoreOf, seedScore, synced } from "./pages";
import { expect, type Page, test } from "./test";

const text = strings.score;

/** An object nested `levels` deep, as JSON. */
function nested(levels: number): string {
  return `${'{"in":'.repeat(levels)}1${"}".repeat(levels)}`;
}

/** What the page's sync indicator shows, each time it changes from now on. */
async function watchSync(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const shown: string[] = [];
    const indicator = document.querySelector("[data-sync]")!;
    new MutationObserver(() => shown.push(indicator.getAttribute("data-sync")!)).observe(indicator, { attributes: true, attributeFilter: ["data-sync"] });
    Object.assign(window, { syncShown: shown });
  });
  return () => page.evaluate(() => (window as unknown as { syncShown: string[] }).syncShown);
}

test("a tab holding a value nested too deep is told, stops connecting, and opens the score anew from the server", async ({ browser }) => {
  const id = seedScore({ title: "太深的值", owner: ADMIN.username });
  const page = await loggedIn(browser, ADMIN);
  const errors = pageErrors(page);
  const tickets: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith(`/api/scores/${id}/collab-ticket`)) tickets.push(request.url());
  });
  await openScore(page, id);
  expect(tickets).toHaveLength(1);
  const syncShown = await watchSync(page);

  // As an older tab, or what it kept offline, holds it: past the commands, which write none.
  await page.evaluate((json) => window.__studioTest!.writeMeta!("later", json), nested(MAX_VALUE_DEPTH + 1));
  const closed = page.locator("[data-closed]");
  await expect(closed).toContainText(text.closed.reasons.tooDeep);
  await expect(page.locator('[data-sync="offline"]')).toBeVisible();
  // Not the offline banner, which says what is typed is merged once back online.
  await expect(page.locator("[data-offline]")).toHaveCount(0);

  // The provider reconnects a second after a close it did not ask for, each time with a new
  // ticket, and the indicator goes back to syncing: over four seconds, that would be several of
  // each. The evidence is what was counted, not the time waited.
  await page.waitForTimeout(4000);
  expect(tickets).toHaveLength(1);
  // Offline once the server closed it, and nothing else since.
  const shown = await syncShown();
  expect(shown.slice(shown.indexOf("offline"))).toEqual(["offline"]);
  await expect(closed).toBeVisible();

  // Opened anew from the server: the value never reached it, and the score is one like any other.
  await page.getByRole("button", { name: text.closed.reload }).click();
  await drawn(page);
  await expect(page.locator(".score__notice")).toContainText(text.closed.reloaded);
  await expect(closed).toHaveCount(0);
  expect(tickets).toHaveLength(2);
  await page.keyboard.press("7");
  await synced(page);
  expect(beatsIn(await scoreOf(page), 0, 0)[0]!.notes).toEqual({ s1: { fret: 7 } });
  // Still connected, and nothing more refused.
  await expect(page.locator("[data-closed]")).toHaveCount(0);
  expect(tickets).toHaveLength(2);
  expect(errors).toEqual([]);
});
