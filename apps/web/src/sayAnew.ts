// A notice for the member above a score or a phrase, for the edit views and the phrase editor alike.
import { nextTick, ref } from "vue";

/** The notice shown (null when there is none), and `say`, which tells the member something anew. */
export function useNotice(initial: string | null = null) {
  const notice = ref<string | null>(initial);
  /**
   * The notice is emptied first, so that the same words said again (the same hint of two drops)
   * are a change the screen reader reads out again (#57).
   */
  function say(said: string): void {
    notice.value = null;
    void nextTick(() => {
      notice.value = said;
    });
  }
  return { notice, say };
}
