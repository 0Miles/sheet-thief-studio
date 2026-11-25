// The colours a score is drawn in, from the theme's tokens: dark on a light page, light on a dark
// one. The engine draws them itself (docs/adr/0003), so the tokens are read here, as the page has
// them now, and given to it again every time the theme changes. And its text, in the page's typeface.
import type { ScoreColors, ScoreRenderer } from "@studio/score-render";

/** The token each colour of the score is drawn in. */
const TOKENS: Record<keyof ScoreColors, string> = {
  notation: "--text-strong",
  secondary: "--text-muted",
  staffLines: "--text-muted",
  barLines: "--text",
};

/** A token as the page has it on `element` now, resolved to a colour (`rgb()` or `rgba()`). */
function resolved(element: HTMLElement, token: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  probe.hidden = true;
  element.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/** The score's colours as the theme has them on `element` now. */
export function scoreColorsOf(element: HTMLElement): ScoreColors {
  const entries = Object.entries(TOKENS).map(([name, token]) => [name, resolved(element, token)]);
  return Object.fromEntries(entries) as ScoreColors;
}

/** The typeface of the page around `element` (`--font-sans`), for the score's text: its titles, names and numbers. */
export function scoreFontOf(element: HTMLElement): string {
  return getComputedStyle(element).fontFamily;
}

/**
 * Draw the score in the theme's colours, now and every time the theme changes: the system's
 * light or dark (`prefers-color-scheme`), or the one chosen on the page (`data-theme` on the root,
 * from `useColorScheme`). Returns a function that stops following it.
 */
export function followTheme(renderer: Pick<ScoreRenderer, "setColors">, element: HTMLElement): () => void {
  const apply = () => renderer.setColors(scoreColorsOf(element));
  apply();
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  system.addEventListener("change", apply);
  const chosen = new MutationObserver(apply);
  chosen.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => {
    system.removeEventListener("change", apply);
    chosen.disconnect();
  };
}
