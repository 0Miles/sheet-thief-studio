// The typing smoke test of the browsers other than Chromium (#38; docs/spec/testing.md, section
// 3): the projects `firefox` and `webkit` run it, the whole suite runs in Chromium only. Logging
// in through the page and reloading also checks that the browser keeps the session cookie over
// http://localhost (docs/spec/testing.md, section 5, check 1).
import { ADMIN } from "../environment";
import { beatsIn, drawn, loggedIn, openScore, pageErrors, scoreOf, seedScore, synced } from "../pages";
import { expect, test } from "../test";

// Playwright's WebKit for Windows has no Web Audio, so alphaTab's player logs that the browser is
// unsupported and never gets to paused; CI runs WebKit on Linux, which has it (#129).
test.skip(({ browserName }) => browserName === "webkit" && process.platform === "win32", "Playwright's WebKit for Windows has no Web Audio (#129)");

test("a member logs in, types a fret, and after reloading the score still holds it", async ({ browser }) => {
  const id = seedScore({ title: "瀏覽器打譜測試", owner: ADMIN.username });
  const page = await loggedIn(browser, ADMIN);
  const errors = pageErrors(page);
  await openScore(page, id);

  // The cursor starts in the append slot of the first bar, on the first string.
  await page.keyboard.press("5");
  await synced(page);

  await page.reload();
  await drawn(page);
  const typed = beatsIn(await scoreOf(page), 0, 0);
  expect(typed).toHaveLength(1);
  expect(typed[0]!.notes.s1).toMatchObject({ fret: 5 });
  expect(errors).toEqual([]);
});
