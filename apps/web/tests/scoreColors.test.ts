// The score follows the theme: drawn in its colours as the page opens, and again every time the
// system's light or dark changes, or the one chosen on the page (`data-theme`).
import type { ScoreColors } from "@studio/score-render";
import { afterEach, expect, test, vi } from "vitest";

import { followTheme } from "../src/scoreColors";

/** The system's light or dark, as `matchMedia` tells it; `change` is what the browser sends when it changes. */
function systemScheme(): EventTarget {
  const query = Object.assign(new EventTarget(), { matches: false, media: "(prefers-color-scheme: dark)" });
  vi.stubGlobal("matchMedia", () => query);
  return query;
}

/** The MutationObserver tells of an attribute after the current task. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute("data-theme");
});

test("the score is drawn in the theme's colours from the start, and again when the system's or the page's theme changes, until it stops following", async () => {
  const system = systemScheme();
  const asked: ScoreColors[] = [];
  const stop = followTheme({ setColors: (colors) => asked.push(colors) }, document.body);
  expect(asked).toHaveLength(1);
  expect(Object.keys(asked[0]!).sort()).toEqual(["barLines", "notation", "secondary", "staffLines"]);

  system.dispatchEvent(new Event("change"));
  expect(asked).toHaveLength(2);

  document.documentElement.setAttribute("data-theme", "dark");
  await settled();
  expect(asked).toHaveLength(3);

  // Another attribute of the root is no theme.
  document.documentElement.setAttribute("lang", "zh-Hant");
  await settled();
  expect(asked).toHaveLength(3);

  stop();
  system.dispatchEvent(new Event("change"));
  document.documentElement.setAttribute("data-theme", "light");
  await settled();
  expect(asked).toHaveLength(3);
});
