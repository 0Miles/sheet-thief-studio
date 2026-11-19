// Whether the score is drawn, as the edit views and the phrase editor show it (`data-ready`), and
// where it is scrolled to, through a renderer that starts over with a new API (#198,
// docs/spec/playback.md, 4.1): the music font or a worker could not be had, the player's alone
// included, and the retry takes what was drawn off the page before it draws the score again.
import type { ScoreRenderer } from "@studio/score-render";
import { nextTick, type Ref, ref } from "vue";

/** What the page does for the score drawn on it. */
export interface DrawnPage {
  /** What the page shows under the score only while it is drawn (the +bar button); none when it shows nothing there. */
  end(): HTMLElement | null | undefined;
  /** Give the score the keyboard. */
  focus(): void;
  /** How far down the score is scrolled; null when nothing scrolls it. */
  scrollTop(): number | null;
  /** Scroll the score there, as the page does (not the member). */
  scrollTo(top: number): void;
  /** Place what the page draws over the score again: the reserved areas, the cursor, the selection, playback. */
  place(): void;
}

export interface DrawnScore {
  /**
   * The score is drawn: from the renderer's first drawing on, but not from the time it starts
   * over until it has drawn again (never, while the new API cannot draw either).
   */
  readonly ready: Ref<boolean>;
  /** Follow a renderer just made. */
  watch(renderer: ScoreRenderer): void;
}

export function drawnScore(page: DrawnPage): DrawnScore {
  const ready = ref(false);
  let watched: ScoreRenderer | null = null;
  /** Where the score was scrolled to when the renderer started over; null once it is back there. */
  let scrolledTo: number | null = null;
  return {
    ready,
    watch(renderer) {
      watched = renderer;
      renderer.onRendered(() => {
        if (watched !== renderer) return;
        ready.value = true;
        page.place();
        const top = scrolledTo;
        if (top === null) return;
        scrolledTo = null;
        // Once the page has what it shows of a score drawn (the button under it): all its height.
        void nextTick(() => page.scrollTo(top));
      });
      renderer.onStartOver(() => {
        if (watched !== renderer) return;
        // The engine may start over by itself (back online), a button the page shows only of a
        // score drawn having the keyboard: once that has left the page, the score has it, not the body.
        const end = page.end();
        const held = end?.contains(document.activeElement) ? end : null;
        ready.value = false;
        if (held) {
          void nextTick(() => {
            if (!held.isConnected) page.focus();
          });
        }
        // The first time, when it starts over again before it has drawn: by now nothing is left to scroll.
        scrolledTo ??= page.scrollTop();
        // Nothing of the score is placed any more: the cursor and the selection of the old drawing go.
        page.place();
      });
    },
  };
}
