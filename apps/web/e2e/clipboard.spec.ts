// Do the clipboard events fire while the score has the keyboard (#52; docs/spec/testing.md,
// section 5, check 3; docs/spec/phrases.md, section 2)? The clipboard goes through the DOM's
// `copy`, `cut` and `paste` events, and the score's keyboard focus is `[data-scroller]` of
// ScoreView.vue: an element with `tabindex="0"`, no text in it selected. The projects `chromium`,
// `firefox` and `webkit` run this spec.
//
// Conclusion: the focus element stays `[data-scroller]`; there is no off-screen <textarea>. With the
// focus on it, Ctrl+C, Ctrl+X and Ctrl+V fire `copy`, `cut` and `paste` in all three browsers, and
// what `copy` and `cut` write as `text/plain` is what `paste` reads. Where the events go differs:
// Chromium and WebKit send them to `[data-scroller]`, Firefox to <body>. So the page listens for
// them on the document and takes them only while `document.activeElement` is the scroller.
//
// Playwright's WebKit for Windows fires the three events but keeps nothing a `copy` or `cut`
// listener writes: `paste` then reads "" there. That is the port's clipboard, not the focus: with
// the focus in a selected off-screen <textarea> it reads "" all the same, while the textarea's own
// selection, copied by the browser, is pasted back (a one-off probe for #52). So on Windows WebKit
// the test asserts the events and that empty text; everywhere else, CI's Linux WebKit included, the
// round trip. CI's WebKit presses Ctrl; Safari's Cmd+C, Cmd+V on a Mac is checked by hand
// (docs/spec/testing.md, section 6, item 8; #77).
import { ADMIN } from "./environment";
import { loggedIn, openScore, pageErrors, seedScore } from "./pages";
import { expect, test } from "./test";

/** What the page heard of one clipboard event. */
interface Heard {
  type: string;
  /** Where the event was sent: the score's focus element, <body>, or another element by tag name. */
  target: string;
  /** Whether the score had the keyboard when it fired. */
  scoreFocused: boolean;
  /** What `paste` read as `text/plain`; null for the others. */
  text: string | null;
}

const COPIED = 'sheet-thief-studio/fragment@1\n{"check":"#52 copy"}';
const CUT = 'sheet-thief-studio/fragment@1\n{"check":"#52 cut"}';

test("with the score focused, Ctrl+C, Ctrl+X and Ctrl+V fire copy, cut and paste, and paste reads what was written", async ({ browser, browserName }) => {
  const id = seedScore({ title: "剪貼簿焦點測試", owner: ADMIN.username });
  const page = await loggedIn(browser, ADMIN);
  const errors = pageErrors(page);
  await openScore(page, id);
  const scroller = page.locator("[data-scroller]");
  await expect(scroller).toBeFocused();
  const before = await page.evaluate(() => window.__studioTest!.scoreJson());

  await page.evaluate(
    ({ copied, cut }) => {
      const heard: Heard[] = [];
      (window as unknown as { __heard: Heard[] }).__heard = heard;
      const scoreFocused = () => document.activeElement?.matches("[data-scroller]") ?? false;
      const target = ({ target }: Event) => {
        if (!(target instanceof Element)) return String(target);
        return target.matches("[data-scroller]") ? "scroller" : target.tagName.toLowerCase();
      };
      for (const [type, written] of [
        ["copy", copied],
        ["cut", cut],
      ] as const) {
        document.addEventListener(type, (event) => {
          event.clipboardData!.setData("text/plain", written);
          // Without it the browser writes the selection, of which there is none, instead.
          event.preventDefault();
          heard.push({ type, target: target(event), scoreFocused: scoreFocused(), text: null });
        });
      }
      document.addEventListener("paste", (event) => {
        heard.push({ type: "paste", target: target(event), scoreFocused: scoreFocused(), text: event.clipboardData!.getData("text/plain") });
        event.preventDefault();
      });
    },
    { copied: COPIED, cut: CUT },
  );
  const heard = () => page.evaluate(() => (window as unknown as { __heard: Heard[] }).__heard);

  // One at a time: the paste is to read what the key before it wrote.
  await page.keyboard.press("Control+KeyC");
  await expect.poll(heard).toHaveLength(1);
  await page.keyboard.press("Control+KeyV");
  await expect.poll(heard).toHaveLength(2);
  await page.keyboard.press("Control+KeyX");
  await expect.poll(heard).toHaveLength(3);
  await page.keyboard.press("Control+KeyV");
  await expect.poll(heard).toHaveLength(4);

  const sentTo = browserName === "firefox" ? "body" : "scroller";
  const keepsWritten = !(browserName === "webkit" && process.platform === "win32");
  expect(await heard()).toEqual([
    { type: "copy", target: sentTo, scoreFocused: true, text: null },
    { type: "paste", target: sentTo, scoreFocused: true, text: keepsWritten ? COPIED : "" },
    { type: "cut", target: sentTo, scoreFocused: true, text: null },
    { type: "paste", target: sentTo, scoreFocused: true, text: keepsWritten ? CUT : "" },
  ]);
  // The keys went to the browser, not to the score: the score is as it was, the focus where it was.
  await expect(scroller).toBeFocused();
  expect(await page.evaluate(() => window.__studioTest!.scoreJson())).toEqual(before);
  expect(errors).toEqual([]);
});
