// Lyrics mode as a page shows it (docs/spec/keymap.md, 6.2), for the edit views and the phrase
// editor alike: Shift+Enter asks for the box (`EditorSession.onEditLyric`), which stays open below
// the beat sung from beat to beat, out of the reserved areas (docs/spec/views.md, section 9). Its
// keys go to `EditorSession.pressLyric`, which saves and says where the box goes.
import type { EditorSession, LyricRequest } from "@studio/score-editor";
import type { Cursor } from "@studio/score-model";
import type { Rect } from "@studio/score-render";
import { shallowRef } from "vue";

import { clearOf, entryRect } from "./overlay";
import { strings } from "./strings";

export interface LyricEntryOptions {
  session: () => EditorSession | undefined;
  /** Where a beat is drawn now; null when it is not. */
  boundsOf: (cursor: Cursor) => Rect | null;
  reserved: () => readonly Rect[];
  /** Tell the member something, above the score. */
  tell: (notice: string) => void;
  /** Lyrics mode is over: the score has the keyboard again. */
  done: () => void;
}

export function useLyricEntry({ session, boundsOf, reserved, tell, done }: LyricEntryOptions) {
  /** The beat lyrics mode is on, while it is. */
  const request = shallowRef<LyricRequest | null>(null);
  /** Where its box is: below that beat. */
  const rect = shallowRef<Rect | null>(null);

  /** Put the box below its beat, as drawn now (after each drawing too); where it was while the beat is not drawn. */
  function place(): void {
    const bounds = request.value && boundsOf(request.value.cursor);
    const at = bounds && clearOf(bounds, reserved());
    if (at) rect.value = entryRect(at, reserved());
  }

  /** Shift+Enter on a staff: the box opens below the beat the session put the cursor on. */
  function open(asked: LyricRequest): void {
    request.value = asked;
    place();
    if (rect.value === null) request.value = null;
  }

  function close(): void {
    if (request.value === null) return;
    drop();
    done();
  }

  /** A key in the box, with what is typed: the session saves and goes on, or ends lyrics mode; any other key is the box's. */
  function onKey(typed: string, event: KeyboardEvent): void {
    const current = request.value;
    const step = current && session()?.pressLyric(current, typed, event);
    if (step == null) return;
    event.preventDefault();
    if (step === "stay") tell(strings.score.lyricTooLong);
    else if (step === "leave") close();
    else {
      request.value = step;
      place();
    }
  }

  /** Lyrics mode ends without the page's word: the score is set aside. */
  function drop(): void {
    request.value = null;
    rect.value = null;
  }

  return { request, rect, place, open, onKey, close, drop };
}
