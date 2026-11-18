// The keys of a Mac in a real browser (#38; docs/spec/testing.md, section 3; docs/spec/keymap.md,
// 1.3): WebKit, told it runs on a Mac, undoes with Cmd+Z. Only the `webkit` project runs it.
import { ADMIN } from "../environment";
import { beatsIn, logInFromStart, openScore, pageErrors, scoreOf, seedScore } from "../pages";
import { expect, type Page, test } from "../test";

async function beatsInFirstBar(page: Page): Promise<number> {
  return beatsIn(await scoreOf(page), 0, 0).length;
}

test("on a Mac, Cmd+Z undoes the fret just typed", async ({ browser }) => {
  const id = seedScore({ title: "Mac 復原測試", owner: ADMIN.username });
  const context = await browser.newContext();
  // What the page tells the platform from (detectKeyPlatform); WebKit has no userAgentData.
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }));
  const page = await context.newPage();
  const errors = pageErrors(page);
  await logInFromStart(page, ADMIN);
  await openScore(page, id);
  expect(await page.evaluate(() => navigator.platform)).toBe("MacIntel");

  await page.keyboard.press("5");
  await expect.poll(() => beatsInFirstBar(page)).toBe(1);
  await page.keyboard.press("Meta+z");
  await expect.poll(() => beatsInFirstBar(page)).toBe(0);
  expect(errors).toEqual([]);
});
