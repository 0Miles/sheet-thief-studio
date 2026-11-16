// The `test` every end-to-end spec imports: Playwright's own, which also hears the Content
// Security Policy violations of every page the test opens and fails the test when there is one
// (docs/spec/testing.md, section 3; docs/spec/security.md, section 7).
import { type Browser, type BrowserContext, expect, test as base } from "@playwright/test";

export * from "@playwright/test";

const BINDING = "__cspViolation";

interface CspWatch {
  violations: string[];
  watch(context: BrowserContext): Promise<void>;
}

export const test = base.extend<{ cspWatch: CspWatch; cspViolations: string[] }>({
  cspWatch: [
    async ({ browser }, use) => {
      const violations: string[] = [];
      const watched = new WeakSet<BrowserContext>();
      const watch = async (context: BrowserContext) => {
        if (watched.has(context)) return;
        watched.add(context);
        await context.exposeBinding(BINDING, (_source, violation: string) => violations.push(violation));
        await context.addInitScript((binding) => {
          document.addEventListener("securitypolicyviolation", (event) => {
            const report = (window as unknown as Record<string, (violation: string) => void>)[binding];
            report?.(`${event.effectiveDirective} blocked ${event.blockedURI || "inline"} on ${location.pathname}`);
          });
        }, BINDING);
        // A worker's violations fire in the worker, where the listener above is not, and Playwright
        // does not pass on what the browser logs about them: Chromium's own log does. It logs a
        // request refused (connect-src, img-src…), not an eval refused, which goes unheard.
        if (browser.browserType().name() !== "chromium") return;
        context.on("page", (page) => {
          void context.newCDPSession(page).then(async (session) => {
            session.on("Log.entryAdded", ({ entry }) => {
              if (entry.source === "worker" && entry.text.includes("Content Security Policy")) violations.push(`in a worker of ${new URL(page.url()).pathname}: ${entry.text}`);
            });
            await session.send("Log.enable");
          });
        });
      };
      // The contexts a test makes itself (`loggedIn` in pages.ts) are watched like the fixture's.
      const newContext = browser.newContext;
      browser.newContext = async (...options: Parameters<Browser["newContext"]>) => {
        const context = await newContext.apply(browser, options);
        await watch(context);
        return context;
      };
      await use({ violations, watch });
      browser.newContext = newContext;
      expect(violations, "Content Security Policy violations").toEqual([]);
    },
    { auto: true },
  ],
  context: async ({ context, cspWatch }, use) => {
    await cspWatch.watch(context);
    await use(context);
  },
  /** What was blocked so far, for the test that expects a violation: it empties the list once it has seen it. */
  cspViolations: async ({ cspWatch }, use) => {
    await use(cspWatch.violations);
  },
});
