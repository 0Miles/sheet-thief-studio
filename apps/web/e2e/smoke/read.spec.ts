// The Read view smoke test of WebKit (#38; docs/spec/testing.md, section 3): a guest, with no
// cookie, opens a read-only link, sees the score drawn, and the player gets to paused (section 5,
// check 2). Only the `webkit` project runs it. Playwright's WebKit for Windows has no Web Audio:
// there the player says it cannot play instead, with no error either (#129).
import { ADMIN } from "../environment";
import { drawn, loggedIn, pageErrors, playerSettled, seedScore } from "../pages";
import { expect, test } from "../test";

test("a guest opens a read-only link: the score is drawn and the player is paused, or says it cannot play without Web Audio", async ({ browser }) => {
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
  await playerSettled(guest);
  expect(await guestContext.cookies()).toEqual([]);
  expect(errors).toEqual([]);
});
