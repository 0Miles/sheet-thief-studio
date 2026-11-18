// The page's side of the clipboard (docs/spec/phrases.md, section 2): the events taken only while
// the score has the keyboard, what is written and read, and what the member is told. That the
// browsers fire them with the keys is in e2e/clipboard.spec.ts.
import type { EditorSession, PasteOutcome } from "@studio/score-editor";
import { expect, test } from "vitest";

import { type ClipboardTarget, listenToClipboard, pasteNotice } from "../src/clipboard";
import { strings } from "../src/strings";

const text = strings.score.clipboard;

/** A clipboard event as a browser fires it, holding `held` as text. */
function clipboardEvent(type: "copy" | "cut" | "paste", held = "") {
  const data = new Map<string, string>([["text/plain", held]]);
  const clipboardData = { setData: (format: string, value: string) => data.set(format, value), getData: (format: string) => data.get(format) ?? "" };
  const event = Object.assign(new Event(type, { cancelable: true }), { clipboardData }) as unknown as ClipboardEvent;
  return { event, written: () => data.get("text/plain") };
}

/** A page whose score has the keyboard or not, a session that answers as told, and what the member was told. */
function page(outcome: PasteOutcome = { hints: [] }) {
  const scroller = { tag: "scroller" } as unknown as Element;
  const target = Object.assign(new EventTarget(), { activeElement: scroller as Element | null }) as unknown as ClipboardTarget & EventTarget & { activeElement: Element | null };
  const calls: string[] = [];
  const session = {
    copy: () => (calls.push("copy"), "copied"),
    cut: () => (calls.push("cut"), null),
    paste: (held: string) => (calls.push(`paste ${held}`), outcome),
  } as unknown as EditorSession;
  const told: string[] = [];
  const stop = listenToClipboard({ scroller: () => scroller, session: () => session, tell: (said) => told.push(said) }, target);
  return { target, calls, told, stop };
}

test("with the score focused, copy writes the session's text instead of the browser's; a cut with nothing to write is left to the browser", () => {
  const { target, calls } = page();
  const copy = clipboardEvent("copy");
  target.dispatchEvent(copy.event);
  expect([copy.written(), copy.event.defaultPrevented]).toEqual(["copied", true]);
  const cut = clipboardEvent("cut", "before");
  target.dispatchEvent(cut.event);
  expect([cut.written(), cut.event.defaultPrevented]).toEqual(["before", false]);
  expect(calls).toEqual(["copy", "cut"]);
});

test("a paste reads the text for the session and tells the member what it said", () => {
  const { target, calls, told } = page("otherKind");
  const paste = clipboardEvent("paste", "held");
  target.dispatchEvent(paste.event);
  expect(paste.event.defaultPrevented).toBe(true);
  expect(calls).toEqual(["paste held"]);
  expect(told).toEqual([text.refused.otherKind]);
});

test("while something else has the keyboard, or once stopped, the events are the browser's", () => {
  const { target, calls, stop } = page();
  target.activeElement = null;
  for (const type of ["copy", "cut", "paste"] as const) {
    const event = clipboardEvent(type, "held");
    target.dispatchEvent(event.event);
    expect(event.event.defaultPrevented).toBe(false);
  }
  target.activeElement = { tag: "other" } as unknown as Element;
  stop();
  expect(calls).toEqual([]);
});

test("what a paste tells: why it was refused, what else it did together, or nothing", () => {
  expect(pasteNotice("nothing")).toBe(strings.score.clipboard.refused.nothing);
  expect(pasteNotice({ hints: ["tuningDiffers", "barsAppended"] })).toBe(`${text.hints.tuningDiffers}${text.joiner}${text.hints.barsAppended}`);
  expect(pasteNotice({ hints: [] })).toBeNull();
  expect(pasteNotice("gone")).toBe(text.refused.gone);
  expect(pasteNotice(null)).toBeNull();
});
