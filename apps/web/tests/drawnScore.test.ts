// Whether the score is drawn, as the page shows it (`data-ready`), while its renderer starts over
// with a new API (#198; docs/spec/playback.md, 4.1), and where the score is scrolled to after it.
import type { ScoreRenderer } from "@studio/score-render";
import { expect, test } from "vitest";
import { nextTick } from "vue";

import { drawnScore } from "../src/drawnScore";

/** A renderer as far as the page asks it when it has drawn and when it starts over. */
function renderer() {
  const drawn: (() => void)[] = [];
  const over: (() => void)[] = [];
  const made = {
    onRendered: (listener: () => void) => {
      drawn.push(listener);
      return () => {};
    },
    onStartOver: (listener: () => void) => {
      over.push(listener);
      return () => {};
    },
  };
  return {
    made: made as unknown as ScoreRenderer,
    drew: () => drawn.forEach((listener) => listener()),
    startsOver: () => over.forEach((listener) => listener()),
  };
}

/** The page the score is on: how far it is scrolled, where it was sent, and how often it placed its overlay, with `ready` as it was then. */
function page() {
  // The score's scroller, and under the score what the page shows only of a score drawn (the +bar button).
  const scroller = document.createElement("div");
  scroller.tabIndex = 0;
  const end = document.createElement("div");
  const button = end.appendChild(document.createElement("button"));
  document.body.replaceChildren(scroller, end);
  const state = { top: 0, sent: [] as number[], placed: [] as boolean[], scroller, end: end as HTMLElement | undefined, button };
  const drawing = drawnScore({
    end: () => state.end,
    focus: () => state.scroller.focus(),
    scrollTop: () => state.top,
    scrollTo: (top) => {
      state.sent.push(top);
      state.top = top;
    },
    place: () => state.placed.push(drawing.ready.value),
  });
  return { state, drawing };
}

/** The page with a renderer it watches. */
function watched() {
  const { state, drawing } = page();
  const { made, drew, startsOver } = renderer();
  drawing.watch(made);
  return { state, drawing, drew, startsOver };
}

test("drawn once the renderer says so; not from the time it starts over until it has drawn again, the overlay placed anew each time", () => {
  const { state, drawing, drew, startsOver } = watched();
  expect(drawing.ready.value).toBe(false);
  drew();
  expect(drawing.ready.value).toBe(true);
  startsOver();
  expect(drawing.ready.value).toBe(false);
  drew();
  expect(drawing.ready.value).toBe(true);
  // Placed each time, with `ready` as it is by then.
  expect(state.placed).toEqual([true, false, true]);
});

test("started over with an API that cannot draw either: not drawn for as long as nothing is", () => {
  const { drawing, drew, startsOver } = watched();
  drew();
  startsOver();
  // It failed: the renderer tells no drawing. Retried, it starts over again.
  expect(drawing.ready.value).toBe(false);
  startsOver();
  expect(drawing.ready.value).toBe(false);
});

test("the score is scrolled back to where it was when the renderer started over, once it is drawn and the page has what it shows then", async () => {
  const { state, drew, startsOver } = watched();
  drew();
  await nextTick();
  expect(state.sent).toEqual([]);
  state.top = 480;
  startsOver();
  // The old drawing is taken off the page: nothing left to scroll.
  state.top = 0;
  drew();
  expect(state.sent).toEqual([]);
  await nextTick();
  expect(state.sent).toEqual([480]);
  // Only once: a later drawing leaves the score where the member has it.
  state.top = 120;
  drew();
  await nextTick();
  expect(state.sent).toEqual([480]);
});

test("started over more than once before it is drawn: back to where it was the first time", async () => {
  const { state, drew, startsOver } = watched();
  drew();
  state.top = 480;
  startsOver();
  state.top = 0;
  startsOver();
  drew();
  await nextTick();
  expect(state.sent).toEqual([480]);
});

test("a renderer watched after another: what the first says is not shown any more", () => {
  const { state, drawing } = page();
  const first = renderer();
  drawing.watch(first.made);
  const second = renderer();
  drawing.watch(second.made);
  first.drew();
  expect(drawing.ready.value).toBe(false);
  second.drew();
  first.startsOver();
  expect(drawing.ready.value).toBe(true);
  expect(state.placed).toEqual([true]);
});

test("started over by itself while a button shown only of a score drawn has the keyboard: once that leaves the page, the score has it", async () => {
  const { state, drew, startsOver } = watched();
  drew();
  state.button.focus();
  expect(document.activeElement).toBe(state.button);
  startsOver();
  // The page shows it no more, as `ready` is false.
  state.end?.remove();
  state.end = undefined;
  await nextTick();
  expect(document.activeElement).toBe(state.scroller);
});

test("started over while the keyboard is elsewhere, or on a button that stays on the page: it stays there", async () => {
  const { state, drew, startsOver } = watched();
  drew();
  // A score with no bars keeps its +bar button.
  state.button.focus();
  startsOver();
  await nextTick();
  expect(document.activeElement).toBe(state.button);

  const elsewhere = document.body.appendChild(document.createElement("input"));
  elsewhere.focus();
  startsOver();
  state.end?.remove();
  await nextTick();
  expect(document.activeElement).toBe(elsewhere);
});
