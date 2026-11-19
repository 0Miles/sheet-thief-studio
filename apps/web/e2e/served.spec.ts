// The web app's build served by the server itself, as in production, with the Content Security
// Policy on every answer (docs/spec/security.md, sections 6 and 7). The only spec of the `served`
// project (playwright.config.ts); every other one gets its pages from `vite preview`.
import { strings } from "../src/strings";
import { ADMIN } from "./environment";
import { createPhrase, createScore, logInFromStart, openPhrase, openScore, originalShown, pageErrors, readOnlyLink, ready, recognizeImage, soundReady } from "./pages";
import { expect, test } from "./test";

test("served by the server, a score opens, is drawn and gets its sound, and so does its read-only link; no page has one CSP violation", async ({ page, browser, cspViolations }) => {
  const errors = pageErrors(page);
  await logInFromStart(page, ADMIN);
  const id = await createScore(page, "由伺服器提供的頁面");
  await openScore(page, id);
  // alphaTab's workers, font and soundfont have all loaded by now.
  await soundReady(page);

  // The panel of the parts, the question asked before a part is deleted, and the title bar's form.
  await page.locator("[data-toggle-parts]").click();
  const parts = page.locator("[data-part-panel]");
  await parts.locator("[data-add-part]").getByLabel(strings.score.parts.preset).selectOption("drums");
  await parts.locator("[data-add-part]").getByRole("button", { name: strings.score.parts.add }).click();
  await expect(parts.locator("[data-part-row]")).toHaveCount(2);
  await parts.locator("[data-part-delete]").last().click();
  const question = page.getByRole("dialog", { name: strings.score.parts.confirmDelete.title });
  await expect(question).toBeVisible();
  await question.getByRole("button", { name: strings.score.parts.confirmDelete.cancel }).click();
  await expect(question).toBeHidden();
  await page.locator("[data-edit-title]").click();
  await expect(page.locator("[data-title-form]")).toBeVisible();
  await page.locator("[data-title-form]").getByRole("button", { name: strings.score.heading.cancel }).click();
  // The mixer at the side of the score.
  await page.locator("[data-toggle-mixer]").click();
  await expect(page.locator("[data-mixer-panel]")).toBeVisible();
  await page.locator("[data-mixer-panel]").getByLabel(strings.score.mixer.metronome).check();

  const answer = await page.request.get(`/scores/${id}`);
  expect(answer.headers()["content-type"]).toContain("text/html");
  expect(answer.headers()["content-security-policy"]).toContain("script-src 'self'");

  // The other pages, each loaded from the server as someone opening its address would.
  for (const [path, heading] of [
    ["/phrases", strings.phrases.title],
    ["/account", strings.account.title],
    ["/admin", strings.admin.title],
    [`/scores/${id}/settings`, strings.settings.link.title],
    [`/scores/${id}/versions`, strings.versions.title],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  }
  // The phrase editor: drawn, and its sound ready.
  const phraseId = await createPhrase(page, `由伺服器提供的樂句 ${Date.now()}`);
  await openPhrase(page, phraseId);
  await soundReady(page);
  // The review page of a recognition: its result drawn with its sound, and its image loaded.
  await recognizeImage(page, "six-strings");
  await soundReady(page);
  await originalShown(page);

  // The page of a read-only link, in a browser that never logged in: drawn, and its sound ready.
  const token = await readOnlyLink(page, id);
  const guest = await (await browser.newContext()).newPage();
  const guestErrors = pageErrors(guest);
  const guestPage = await guest.goto(`/s/${token}`);
  expect(guestPage!.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(guestPage!.headers()["referrer-policy"]).toBe("no-referrer");
  await ready(guest);
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
