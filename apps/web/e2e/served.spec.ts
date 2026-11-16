// The web app's build served by the server itself, as in production, with the Content Security
// Policy on every answer (docs/spec/security.md, sections 6 and 7). The only spec of the `served`
// project (playwright.config.ts); every other one gets its pages from `vite preview`.
import { ADMIN } from "./environment";
import { createScore, logInFromStart, openScore, pageErrors, soundReady } from "./pages";
import { expect, test } from "./test";

test("served by the server, a score opens, is drawn and gets its sound without one CSP violation", async ({ page, cspViolations }) => {
  const errors = pageErrors(page);
  await logInFromStart(page, ADMIN);
  const id = await createScore(page, "由伺服器提供的頁面");
  await openScore(page, id);
  // alphaTab's workers, font and soundfont have all loaded by now.
  await soundReady(page);

  const answer = await page.request.get(`/scores/${id}`);
  expect(answer.headers()["content-type"]).toContain("text/html");
  expect(answer.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(errors).toEqual([]);
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
});
