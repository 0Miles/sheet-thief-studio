// Leaving a page with changes that would be lost (the phrase editor, the review page of a
// recognition; docs/spec/phrases.md, sections 5.1 and 7): another page of the app waits for the
// member's answer to the page's own question; closing or reloading the page has the browser ask.
import { onBeforeUnmount, ref } from "vue";

/**
 * The question the page asks before the router leaves it. `leaving` is set while it is asked (the
 * page shows its dialog then, and calls it with the answer); `ask` resolves with that answer.
 */
export function useLeaveQuestion() {
  const leaving = ref<((leave: boolean) => void) | null>(null);
  function ask(): Promise<boolean> {
    return new Promise((resolve) => {
      leaving.value = (leave) => {
        leaving.value = null;
        resolve(leave);
      };
    });
  }
  return { leaving, ask };
}

/** Have the browser ask before the page is closed or reloaded whenever `warn` says so (it may also start what saves the changes), until the component goes. */
export function warnBeforeUnload(warn: () => boolean): void {
  const listener = (event: BeforeUnloadEvent) => {
    if (warn()) event.preventDefault();
  };
  window.addEventListener("beforeunload", listener);
  onBeforeUnmount(() => window.removeEventListener("beforeunload", listener));
}
