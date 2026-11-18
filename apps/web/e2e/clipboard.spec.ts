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
//
// Then the clipboard itself (#58; docs/spec/commands.md, 5.6): bars copied from one score and
// pasted into another, beats cut and pasted, and a Viewer's bars copied into their own phrase. On
// Windows WebKit, where `paste` reads "", those tests assert that the events were taken (the cut
// clears, the paste says there is nothing to paste) instead of the round trip.
import { type BarsFragment, fragmentOfBars, type ScoreJSON, scoreToFragment } from "@studio/score-model";

import { strings } from "../src/strings";
import { ADMIN, VIEWER } from "./environment";
import { createPhrase, loggedIn, openScore, pageErrors, runName, scoreOf, seedScore, synced } from "./pages";
import { expect, type Page, test } from "./test";

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

/** Whether `paste` reads what `copy` and `cut` wrote here: not in Playwright's WebKit for Windows (see above). */
function roundTrips(browserName: string): boolean {
  return !(browserName === "webkit" && process.platform === "win32");
}

/** The frets of each beat of the first voice of a bar of the first part, on whatever string. */
async function fretsIn(page: Page, bar: number): Promise<(number | undefined)[]> {
  const score = await scoreOf(page);
  const beats = score.parts[0]!.content[score.bars[bar]!.id]?.["0:0"] ?? [];
  return beats.map((beat) => Object.values(beat.notes)[0]?.fret);
}

/** Type notes from the cursor's bar on, a list of frets a bar: each a beat of its own, a bar after another. */
async function typeBars(page: Page, bars: number[][]): Promise<void> {
  for (const [index, frets] of bars.entries()) {
    if (index > 0) await page.keyboard.press("Control+ArrowRight");
    for (const [at, fret] of frets.entries()) {
      if (at > 0) await page.keyboard.press("ArrowRight");
      await page.keyboard.press(String(fret));
    }
  }
  for (const [index, frets] of bars.entries()) await expect.poll(() => fretsIn(page, index)).toEqual(frets);
}

/** Bars of the first part, by index, as a copy of them holds them. */
function barsOf(score: ScoreJSON, first: number, last: number): BarsFragment {
  return fragmentOfBars(score, { partId: score.parts[0]!.id, anchorBarId: score.bars[first]!.id, focusBarId: score.bars[last]!.id })!;
}

test("bars 1–2 copied in one score and pasted at bar 5 of another are the same there", async ({ browser, browserName }) => {
  const from = seedScore({ title: runName("複製來源"), owner: ADMIN.username, bars: 4 });
  const to = seedScore({ title: runName("貼上目標"), owner: ADMIN.username, bars: 6 });
  const page = await loggedIn(browser, ADMIN);
  const errors = pageErrors(page);
  await openScore(page, from);
  await typeBars(page, [[1, 2], [3]]);
  await page.keyboard.press("Control+ArrowLeft");
  await page.keyboard.press("Control+Shift+ArrowRight");
  const copied = barsOf(await scoreOf(page), 0, 1);
  await page.keyboard.press("Control+KeyC");
  await synced(page);

  await openScore(page, to);
  const before = await scoreOf(page);
  for (let bar = 1; bar < 5; bar++) await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("Control+KeyV");
  if (roundTrips(browserName)) {
    await expect.poll(async () => barsOf(await scoreOf(page), 4, 5)).toEqual(copied);
    expect((await scoreOf(page)).bars).toHaveLength(6);
  } else {
    await expect(page.getByText(strings.score.clipboard.refused.nothing)).toBeVisible();
    expect(await scoreOf(page)).toEqual(before);
  }
  await expect(page.locator("[data-scroller]")).toBeFocused();
  expect(errors).toEqual([]);
});

test("three beats cut are cleared, and pasted elsewhere are inserted; each is one undo step", async ({ browser, browserName }) => {
  const id = seedScore({ title: runName("剪下拍點"), owner: ADMIN.username, bars: 4 });
  const page = await loggedIn(browser, ADMIN);
  const errors = pageErrors(page);
  await openScore(page, id);
  await typeBars(page, [[1, 2, 3]]);
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Control+KeyX");
  // The notes go; the beats stay, rests.
  await expect.poll(() => fretsIn(page, 0)).toEqual([undefined, undefined, undefined]);

  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("Control+KeyV");
  if (roundTrips(browserName)) {
    await expect.poll(() => fretsIn(page, 1)).toEqual([1, 2, 3]);
    await page.keyboard.press("Control+KeyZ");
    await expect.poll(() => fretsIn(page, 1)).toEqual([]);
    expect(await fretsIn(page, 0)).toEqual([undefined, undefined, undefined]);
  } else {
    await expect(page.getByText(strings.score.clipboard.refused.nothing)).toBeVisible();
    expect(await fretsIn(page, 1)).toEqual([]);
  }
  await page.keyboard.press("Control+KeyZ");
  await expect.poll(() => fretsIn(page, 0)).toEqual([1, 2, 3]);
  expect(errors).toEqual([]);
});

test("a Viewer copies bars of the score into their own phrase; their Ctrl+X changes nothing", async ({ browser, browserName }) => {
  const id = seedScore({ title: runName("檢視者複製"), owner: ADMIN.username, members: [{ username: VIEWER.username, role: "viewer" }], bars: 4 });
  const owner = await loggedIn(browser, ADMIN);
  const ownerErrors = pageErrors(owner);
  await openScore(owner, id);
  await typeBars(owner, [[1], [3, 5]]);
  await synced(owner);
  expect(ownerErrors).toEqual([]);
  await owner.context().close();

  const page = await loggedIn(browser, VIEWER);
  const errors = pageErrors(page);
  const phraseId = await createPhrase(page, runName("貼進來的樂句"));
  await openScore(page, id);
  await expect(page.locator("main")).toHaveAttribute("data-view", "readOnlyEdit");
  await page.keyboard.press("Control+Shift+ArrowRight");
  await expect(page.locator("[data-selection]")).not.toHaveCount(0);
  const score = await scoreOf(page);
  const copied = barsOf(score, 0, 1);
  await page.keyboard.press("Control+KeyC");
  await page.keyboard.press("Control+KeyX");
  await expect(page.getByText(strings.score.viewerCannotEdit)).toBeVisible();
  expect(await scoreOf(page)).toEqual(score);

  await page.goto(`/phrases/${phraseId}`);
  await expect(page.locator('[data-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator("[data-scroller]")).toBeFocused();
  const blank = scoreToFragment(await scoreOf(page));
  await page.keyboard.press("Control+KeyV");
  if (roundTrips(browserName)) {
    await expect.poll(async () => scoreToFragment(await scoreOf(page))).toEqual(copied);
    // The phrase had one bar: the second was appended, and the member told so.
    await expect(page.getByText(strings.score.clipboard.hints.barsAppended)).toBeVisible();
    // And it is saved so.
    await expect.poll(async () => ((await (await page.request.get(`/api/phrases/${phraseId}`)).json()) as { fragment: BarsFragment }).fragment).toEqual(copied);
  } else {
    await expect(page.getByText(strings.score.clipboard.refused.nothing)).toBeVisible();
    expect(scoreToFragment(await scoreOf(page))).toEqual(blank);
  }
  expect(errors).toEqual([]);
});
