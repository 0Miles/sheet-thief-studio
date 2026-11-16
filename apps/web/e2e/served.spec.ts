// The web app's build served by the server itself, as in production, with the Content Security
// Policy on every answer (docs/spec/security.md, sections 6 and 7). The only spec of the `served`
// project (playwright.config.ts); every other one gets its pages from `vite preview`.
import { strings } from "../src/strings";
import { ADMIN } from "./environment";
import { createScore, logInFromStart, openScore, pageErrors, soundReady } from "./pages";
import { expect, test } from "./test";

test("served by the server, a score opens, is drawn and gets its sound, and so does its read-only link; no page has one CSP violation", async ({ page, browser, cspViolations }) => {
  const errors = pageErrors(page);
  await logInFromStart(page, ADMIN);
  const id = await createScore(page, "由伺服器提供的頁面");
  await openScore(page, id);
  // alphaTab's workers, font and soundfont have all loaded by now.
  await soundReady(page);

  const answer = await page.request.get(`/scores/${id}`);
  expect(answer.headers()["content-type"]).toContain("text/html");
  expect(answer.headers()["content-security-policy"]).toContain("script-src 'self'");

  // The other pages, each loaded from the server as someone opening its address would.
  for (const [path, heading] of [
    ["/phrases", strings.phrases.title],
    ["/account", strings.account.title],
    ["/admin", strings.admin.title],
    [`/scores/${id}/settings`, strings.settings.link.title],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }

  // The page of a read-only link, in a browser that never logged in: drawn, and its sound ready.
  const made = await page.request.post(`/api/scores/${id}/link`, { headers: { origin: new URL(page.url()).origin } });
  expect(made.status()).toBe(200);
  const { token } = (await made.json()) as { token: string };
  const guest = await (await browser.newContext()).newPage();
  const guestErrors = pageErrors(guest);
  const guestPage = await guest.goto(`/s/${token}`);
  expect(guestPage!.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(guestPage!.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(guest.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await soundReady(guest);

  expect(errors).toEqual([]);
  expect(guestErrors).toEqual([]);
  expect(cspViolations).toEqual([]);

  // The policy is in force, and a violation is heard: an inline script does not run.
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__inlineScriptRan = true";
    document.head.append(script);
  });
  await expect.poll(() => cspViolations.length).toBeGreaterThan(0);
  expect(cspViolations[0]).toContain("script-src");
  expect(await page.evaluate(() => "__inlineScriptRan" in window)).toBe(false);
  cspViolations.length = 0;

  // So is one in a worker (alphaTab's run in workers): a worker started as alphaTab starts its
  // own, from a blob: URL, may not reach another host either. The address is never reached.
  await page.evaluate(() => {
    const source = 'fetch("https://elsewhere.invalid/x").then(() => postMessage("reached"), () => postMessage("refused"));';
    const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
    worker.onmessage = ({ data }) => document.body.setAttribute("data-worker-fetch", String(data));
  });
  await expect(page.locator("body")).toHaveAttribute("data-worker-fetch", "refused");
  await expect.poll(() => cspViolations.length).toBeGreaterThan(0);
  expect(cspViolations[0]).toContain("in a worker");
  expect(cspViolations[0]).toContain("connect-src");
  cspViolations.length = 0;
});
