// The Read view smoke test of WebKit (#38; docs/spec/testing.md, section 3): a guest, with no
// cookie, opens a read-only link, sees the score drawn, and the player gets to paused (section 5,
// check 2). Only the `webkit` project runs it.
import { ADMIN } from "../environment";
import { drawn, loggedIn, pageErrors, seedScore, soundReady } from "../pages";
import { expect, test } from "../test";

// Playwright's WebKit for Windows has no Web Audio, so alphaTab's player logs that the browser is
// unsupported and never gets to paused; CI runs WebKit on Linux, which has it (#129).
test.skip(({ browserName }) => browserName === "webkit" && process.platform === "win32", "Playwright's WebKit for Windows has no Web Audio (#129)");

test("a guest opens a read-only link: the score is drawn and the player is paused", async ({ browser }) => {
  const id = seedScore({ title: "瀏覽器看譜測試", owner: ADMIN.username });
  const owner = await loggedIn(browser, ADMIN);
  const made = await owner.request.post(`/api/scores/${id}/link`, { headers: { origin: new URL(owner.url()).origin } });
  expect(made.status()).toBe(200);
  const { token } = (await made.json()) as { token: string };

  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  const errors = pageErrors(guest);
  await guest.goto(`/s/${token}`);
  await drawn(guest);
  await expect(guest.locator("main")).toHaveAttribute("data-view", "read");
  await soundReady(guest);
  expect(await guestContext.cookies()).toEqual([]);
  expect(errors).toEqual([]);
});
