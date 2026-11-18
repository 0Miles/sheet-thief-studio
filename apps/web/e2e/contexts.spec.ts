// The browser contexts a test makes itself (`loggedIn` in pages.ts) are closed when it ends, like
// the fixture's own (e2e/test.ts). Left open, every page of the suite stayed alive in the one
// browser of the worker: by the versions spec, near the end, some 240 contexts and 120 pages with
// their scores, sockets and sound fonts, until CI's runner slowed down for everything on it and
// a test ran out of time (docs/spec/testing.md, section 3).
import { ADMIN } from "./environment";
import { loggedIn } from "./pages";
import { expect, test } from "./test";

test.describe.configure({ mode: "serial" });

test("a test opens a browser context of its own and leaves it open", async ({ browser }) => {
  const page = await loggedIn(browser, ADMIN);
  expect(browser.contexts()).toContain(page.context());
});

test("the next test finds no browser context left by the one before", async ({ browser }) => {
  expect(browser.contexts()).toEqual([]);
});
