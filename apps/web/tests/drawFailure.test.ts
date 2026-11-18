// Whether the score could not be drawn, as the page shows it (#151): a ref following the renderer
// watched last, and its retry.
import type { ScoreRenderer } from "@studio/score-render";
import { expect, test } from "vitest";

import { drawFailure } from "../src/drawFailure";

/** A renderer as far as the page asks it whether it can draw. */
function renderer(failed: boolean) {
  const listeners: ((failed: boolean) => void)[] = [];
  let retries = 0;
  const made = {
    failed,
    onFailed: (listener: (failed: boolean) => void) => {
      listeners.push(listener);
      return () => {};
    },
    retry: () => {
      retries += 1;
    },
  };
  return {
    made: made as unknown as ScoreRenderer,
    tell: (now: boolean) => listeners.forEach((listener) => listener(now)),
    retries: () => retries,
  };
}

test("follows what the renderer says now and every change; a retry asks it again", () => {
  const drawing = drawFailure();
  expect(drawing.failed.value).toBe(false);
  drawing.retry();
  const first = renderer(true);
  drawing.watch(first.made);
  expect(drawing.failed.value).toBe(true);
  first.tell(false);
  expect(drawing.failed.value).toBe(false);
  first.tell(true);
  drawing.retry();
  expect(first.retries()).toBe(1);
});

test("a renderer watched after another: what the first says is not shown any more", () => {
  const drawing = drawFailure();
  const first = renderer(false);
  drawing.watch(first.made);
  const second = renderer(false);
  drawing.watch(second.made);
  first.tell(true);
  expect(drawing.failed.value).toBe(false);
  drawing.retry();
  expect([first.retries(), second.retries()]).toEqual([0, 1]);
});
