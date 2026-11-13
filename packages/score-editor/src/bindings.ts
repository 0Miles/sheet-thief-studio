// The keymap as data (docs/spec/keymap.md): which keys run which action, in which context, and the
// keys each platform keeps for itself. A ticket that adds a key adds a row here; the platform
// layer's tests then check it on both platforms (keymap.md, 1.3).
import type { PartKind } from "@studio/score-model";

import type { Chord, KeyPlatform } from "./keys";

/** What a key does; the session runs it (docs/spec/commands.md). */
export type KeyAction =
  | "nextBeat"
  | "previousBeat"
  | "lineDown"
  | "lineUp"
  | "insertBeat"
  | "delete"
  | "shorter"
  | "longer"
  | "undo"
  | "redo"
  | "copy"
  | "cut"
  | "paste"
  | "fret";

/** Where a key works: on the score whatever the kind of the part, or on parts of one kind only. */
export type KeyContext = "score" | PartKind;

export interface KeyBinding {
  action: KeyAction;
  context: KeyContext;
  /** The keys, on every platform unless `mac` says otherwise. */
  keys: readonly Chord[];
  /**
   * The keys on a Mac, where they are not those of `keys`: a Mac has no `Insert` key, and some
   * keys of Windows are the browser's on a Mac (keymap.md, 1.3).
   */
  mac?: readonly Chord[];
  /** Held down, the key's auto-repeat runs it again: moves, `+` and `-` only (keymap.md, 1.1). */
  repeat?: true;
  /**
   * The browser does the work: the key is not `preventDefault`-ed, so that the browser fires its
   * `copy`, `cut` or `paste` event (keymap.md, 1.1).
   */
  native?: true;
  /**
   * The keys as keymap.md writes them for each platform, for the tests: modifiers by the name on
   * the keyboard (`Ctrl`, `Alt`, `Shift`, `Win`; on a Mac `Ctrl`, `Option`, `Shift`, `Cmd`) and
   * the key by its `code`, as in `"Cmd+Shift+KeyZ"`.
   */
  keymap: Record<KeyPlatform, readonly string[]>;
}

const DIGITS = [..."0123456789"];
const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** The digits of a fret, on the row of digits and on the numeric keypad. */
const FRET_KEYS = DIGITS.flatMap((digit) => [`Digit${digit}`, `Numpad${digit}`]);

/** The same keys on both platforms. */
const both = (...keys: string[]): Record<KeyPlatform, readonly string[]> => ({ other: keys, mac: keys });

export const KEY_BINDINGS: readonly KeyBinding[] = [
  // Section 2: the keys of every kind of part.
  { action: "nextBeat", context: "score", keys: ["ArrowRight"], repeat: true, keymap: both("ArrowRight") },
  { action: "previousBeat", context: "score", keys: ["ArrowLeft"], repeat: true, keymap: both("ArrowLeft") },
  { action: "lineDown", context: "score", keys: ["ArrowDown"], repeat: true, keymap: both("ArrowDown") },
  { action: "lineUp", context: "score", keys: ["ArrowUp"], repeat: true, keymap: both("ArrowUp") },
  { action: "insertBeat", context: "score", keys: ["Insert"], mac: ["Alt+Enter"], keymap: { other: ["Insert"], mac: ["Option+Enter"] } },
  // The key marked delete on a Mac keyboard sends Backspace; Fn+delete sends Delete.
  { action: "delete", context: "score", keys: ["Delete", "Backspace"], keymap: both("Delete", "Backspace") },
  // `+` is Shift+= on most keyboards: with or without Shift.
  { action: "shorter", context: "score", keys: ["Equal", "Shift+Equal", "NumpadAdd"], repeat: true, keymap: both("Equal", "Shift+Equal", "NumpadAdd") },
  { action: "longer", context: "score", keys: ["Minus", "NumpadSubtract"], repeat: true, keymap: both("Minus", "NumpadSubtract") },
  { action: "undo", context: "score", keys: ["Mod+KeyZ"], keymap: { other: ["Ctrl+KeyZ"], mac: ["Cmd+KeyZ"] } },
  // Not Cmd+Y on a Mac: it is the history of Safari and Chrome.
  { action: "redo", context: "score", keys: ["Mod+Shift+KeyZ", "Mod+KeyY"], mac: ["Mod+Shift+KeyZ"], keymap: { other: ["Ctrl+Shift+KeyZ", "Ctrl+KeyY"], mac: ["Cmd+Shift+KeyZ"] } },
  // Windows' older Shift+Delete and Shift+Insert fire the same events; a Mac has neither.
  { action: "copy", context: "score", keys: ["Mod+KeyC"], native: true, keymap: { other: ["Ctrl+KeyC"], mac: ["Cmd+KeyC"] } },
  { action: "cut", context: "score", keys: ["Mod+KeyX", "Shift+Delete"], mac: ["Mod+KeyX"], native: true, keymap: { other: ["Ctrl+KeyX", "Shift+Delete"], mac: ["Cmd+KeyX"] } },
  { action: "paste", context: "score", keys: ["Mod+KeyV", "Shift+Insert"], mac: ["Mod+KeyV"], native: true, keymap: { other: ["Ctrl+KeyV", "Shift+Insert"], mac: ["Cmd+KeyV"] } },
  // Section 4.1.
  { action: "fret", context: "fretted", keys: FRET_KEYS, keymap: both(...FRET_KEYS) },
];

/**
 * The keys no binding may be on (keymap.md, 1.2): the operating system takes them first, the
 * browser cannot be kept from them, or they take the focus away. Written as `KeyBinding.keymap`
 * is; `*` stands for any key with those modifiers held, and any others besides.
 */
export const FORBIDDEN_KEYS: Record<KeyPlatform, readonly string[]> = {
  other: [
    ...["KeyT", "KeyW", "KeyN"].flatMap((code) => [`Ctrl+${code}`, `Ctrl+Shift+${code}`]),
    "Ctrl+Tab",
    "Ctrl+PageUp",
    "Ctrl+PageDown",
    "Alt+F4",
    // Firefox's bookmarks sidebar.
    "Ctrl+KeyB",
    // The address bar, reloading, caret browsing, Firefox's reader view, the menus, full screen, the developer tools.
    "Ctrl+KeyL",
    "F5",
    "F6",
    "F7",
    "F9",
    "F10",
    "F11",
    "F12",
    "Ctrl+KeyR",
    "Ctrl+Shift+KeyI",
    ...["P", "F", "H", "J", "D", "E", "K", "U"].map((letter) => `Ctrl+Key${letter}`),
    "Ctrl+Shift+KeyB",
    // Zoom.
    ...["Equal", "Shift+Equal", "NumpadAdd", "Minus", "NumpadSubtract", "Digit0", "Numpad0"].map((key) => `Ctrl+${key}`),
    // The menus of Firefox on Windows (Alt+D is the address bar).
    ...LETTERS.map((letter) => `Alt+Key${letter}`),
    // Linux desktops switch workspaces with them; on Windows, AltGr is Ctrl+Alt.
    "Ctrl+Alt+*",
  ],
  mac: [
    // Taken by macOS before the browser: Mission Control and Spaces, the input sources, Spotlight,
    // switching and hiding apps, screenshots, locking the screen, emoji, the Dock.
    ...["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].map((code) => `Ctrl+${code}`),
    "Ctrl+Space",
    "Ctrl+Option+Space",
    "Cmd+Space",
    "Cmd+Tab",
    "Cmd+Backquote",
    "Cmd+KeyH",
    "Cmd+Option+KeyH",
    "Cmd+KeyM",
    "Cmd+KeyQ",
    "Cmd+Option+Escape",
    "Cmd+Shift+Digit3",
    "Cmd+Shift+Digit4",
    "Cmd+Shift+Digit5",
    "Ctrl+Cmd+KeyQ",
    "Ctrl+Cmd+Space",
    "Cmd+Option+KeyD",
    // The browser's: tabs and windows, the address bar, reloading, back and forward, finding,
    // printing, saving, bookmarks, history, settings, zoom, the developer tools, full screen.
    ...["KeyT", "KeyW", "KeyN"].flatMap((code) => [`Cmd+${code}`, `Cmd+Shift+${code}`]),
    ...DIGITS.slice(1).map((digit) => `Cmd+Digit${digit}`),
    "Cmd+Option+ArrowLeft",
    "Cmd+Option+ArrowRight",
    "Cmd+Shift+BracketLeft",
    "Cmd+Shift+BracketRight",
    "Ctrl+Tab",
    "Cmd+KeyL",
    "Cmd+KeyR",
    "Cmd+Shift+KeyR",
    "Cmd+BracketLeft",
    "Cmd+BracketRight",
    "Cmd+ArrowLeft",
    "Cmd+ArrowRight",
    ...["F", "G", "E", "P", "S", "D", "Y", "I"].map((letter) => `Cmd+Key${letter}`),
    "Cmd+Shift+KeyB",
    "Cmd+Option+KeyB",
    "Cmd+Comma",
    ...["Equal", "Shift+Equal", "NumpadAdd", "Minus", "NumpadSubtract", "Digit0", "Numpad0"].map((key) => `Cmd+${key}`),
    ...["I", "J", "C", "U"].map((letter) => `Cmd+Option+Key${letter}`),
    "Ctrl+Cmd+KeyF",
    // Option with a letter types a character, or is a dead key: a Mac binds none (keymap.md, 1.2).
    // F1-F12 without Fn are the Mac's own keys too, but the page cannot tell Fn: a Mac binds a
    // function key only with a button of the same action next to it (keymap.md, sections 5 and 7).
    ...LETTERS.map((letter) => `Option+Key${letter}`),
  ],
};
