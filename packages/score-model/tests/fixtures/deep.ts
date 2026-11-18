// Values nested deep, and updates that hold one (#102): the server's tests use them too.
import * as Y from "yjs";

/** An object nested `levels` deep, `{"in":{"in":…1}}`, as JSON: `levels` is its depth. */
export function nested(levels: number): string {
  return `${'{"in":'.repeat(levels)}1${"}".repeat(levels)}`;
}

/** What lib0's writeAny writes for a short ASCII string, its tag first: its length fits one byte. */
function anyString(text: string): number[] {
  return [119, text.length, ...[...text].map((char) => char.charCodeAt(0))];
}

const PLACEHOLDER = "deep value goes here";

/**
 * An update that sets `field` of the top-level map `map` to an object nested `levels` deep, made
 * without lib0 following it down: writing a value some thousands deep overflows the stack as
 * reading it does. It is the update of a placeholder string, its bytes swapped for the value's
 * (an object of one field, `in`, `levels` times; null at the bottom). Decoding it overflows the
 * stack when `levels` is large enough.
 */
export function deepUpdate(levels: number, map = "parts", field = "deep"): Uint8Array {
  const doc = new Y.Doc();
  doc.getMap(map).set(field, PLACEHOLDER);
  const update = [...Y.encodeStateAsUpdate(doc)];
  const placeholder = anyString(PLACEHOLDER);
  const at = update.findIndex((_, index) => placeholder.every((byte, offset) => update[index + offset] === byte));
  const level = [118, 1, ...anyString("in").slice(1)];
  const value: number[] = [];
  for (let i = 0; i < levels; i++) value.push(...level);
  value.push(126);
  return Uint8Array.from([...update.slice(0, at), ...value, ...update.slice(at + placeholder.length)]);
}
