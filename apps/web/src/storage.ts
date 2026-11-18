// What this browser keeps for one member (localStorage): display options, the mix and the playback
// settings. Storage can be blocked or full; then each value holds for the page only.

/** What is stored under a key; null when nothing is, or it cannot be read (storage blocked, or not JSON). */
export function readStored(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Store a value under a key; when storage is blocked or full, nothing is kept. */
export function writeStored(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked or full: the value holds for this page only.
  }
}
