// Whose a key pressed inside the score's scroller is (#197; docs/spec/keymap.md, 1.1): the
// scroller hears every key of what it holds, the +bar button and the retry of a score that could
// not be drawn among them. With the focus on one of those, the key is the element's own: Space and
// Enter press the button, and the score neither plays nor types.

/** What does its own thing with the keys: buttons, links, fields. */
const OWN_KEYS = "button, a[href], input, select, textarea";

/** The key was pressed on, or inside, something that has its own keys: not a key of the score. */
export function hasOwnKeys(event: KeyboardEvent): boolean {
  return event.target instanceof Element && event.target.closest(OWN_KEYS) !== null;
}
