// Whether the score could not be drawn: the music font, or the worker that lays it out, could not
// be had (#151, docs/spec/playback.md, 4.1). The engine asks for them again by itself once the
// browser is back online; `retry` asks now.
import type { ScoreRenderer } from "@studio/score-render";
import { type Ref, ref } from "vue";

export interface DrawFailure {
  /** The renderer last watched cannot draw. */
  readonly failed: Ref<boolean>;
  /** Follow a renderer just made: what it says now, and every change. */
  watch(renderer: ScoreRenderer): void;
  /** Ask the renderer watched for what it could not have again. */
  retry(): void;
}

export function drawFailure(): DrawFailure {
  const failed = ref(false);
  let watched: ScoreRenderer | null = null;
  return {
    failed,
    watch(renderer) {
      watched = renderer;
      failed.value = renderer.failed;
      renderer.onFailed((now) => {
        if (watched === renderer) failed.value = now;
      });
    },
    retry() {
      watched?.retry();
    },
  };
}
