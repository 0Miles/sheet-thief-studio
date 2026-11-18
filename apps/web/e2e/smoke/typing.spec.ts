// The typing smoke test of the browsers other than Chromium (#38; docs/spec/testing.md, section
// 3): the projects `firefox` and `webkit` run it, the whole suite runs in Chromium only. Logging
// in through the page and reloading also checks that the browser keeps the session cookie over
// http://localhost (docs/spec/testing.md, section 5, check 1).
import { ADMIN } from "../environment";
import { beatsIn, drawn, loggedIn, openScore, pageErrors, scoreOf, seedScore, synced } from "../pages";
import { expect, test } from "../test";

test("a member logs in, types a fret, and after reloading the score still holds it", async ({ browser, browserName }) => {
  const id = seedScore({ title: "瀏覽器打譜測試", owner: ADMIN.username });
  const page = await loggedIn(browser, ADMIN);
  const errors = pageErrors(page);
  // The session cookie it was given: `__Host-` for Firefox, which takes it over http://localhost;
  // WebKit, which does not, logs in to the server with the development cookie (playwright.config.ts).
  const cookies = (await page.context().cookies()).map(({ name }) => name);
  expect(cookies).toContain(browserName === "webkit" ? "studio_session" : "__Host-studio_session");
  if (browserName === "webkit") expect(cookies.filter((name) => name.startsWith("__Host-"))).toEqual([]);
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
