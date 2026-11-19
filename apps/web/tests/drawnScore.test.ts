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
  const state = { top: 0, sent: [] as number[], placed: [] as boolean[] };
  const drawing = drawnScore({
    scrollTop: () => state.top,
    scrollTo: (top) => {
      state.sent.push(top);
      state.top = top;
    },
    place: () => state.placed.push(drawing.ready.value),
  });
  return { state, drawing };
}

test("drawn once the renderer says so; not from the time it starts over until it has drawn again, the overlay placed anew each time", () => {
  const { state, drawing } = page();
  const { made, drew, startsOver } = renderer();
  drawing.watch(made);
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
  const { drawing } = page();
  const { made, drew, startsOver } = renderer();
  drawing.watch(made);
  drew();
  startsOver();
  // It failed: the renderer tells no drawing. Retried, it starts over again.
  expect(drawing.ready.value).toBe(false);
  startsOver();
  expect(drawing.ready.value).toBe(false);
});

test("the score is scrolled back to where it was when the renderer started over, once it is drawn and the page has what it shows then", async () => {
  const { state, drawing } = page();
  const { made, drew, startsOver } = renderer();
  drawing.watch(made);
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
  const { state, drawing } = page();
  const { made, drew, startsOver } = renderer();
  drawing.watch(made);
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
