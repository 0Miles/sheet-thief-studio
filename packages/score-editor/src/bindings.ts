// The keymap as data (docs/spec/keymap.md): which keys have which effect, in which context, and the
// keys each platform keeps for itself. A ticket that adds a key adds a row here; the platform
// layer's tests then check it on both platforms (keymap.md, 1.3).
import type { PartKind } from "@studio/score-model";

import type { Chord, KeyPlatform } from "./keys";

/** What a key the session handles does: a move, or a command (docs/spec/commands.md). */
export type SessionEffect =
  | "nextBeat"
  | "previousBeat"
  | "lineDown"
  | "lineUp"
  | "selectNextBeat"
  | "selectPreviousBeat"
  | "selectNextBar"
  | "selectPreviousBar"
  | "deselect"
  | "insertBeat"
  | "delete"
  | "shorter"
  | "longer"
  | "undo"
  | "redo"
  | "fret";

/**
 * What a key the browser handles does: it fires its `copy`, `cut` or `paste` event, where the
 * clipboard's work is done (keymap.md, 1.1; docs/spec/phrases.md).
 */
export type NativeEffect = "copy" | "cut" | "paste";

/** What a key the page handles does, outside the score: playing (docs/spec/playback.md, section 4). */
export type PageEffect = "playPause";

/** Where a key works: on the score whatever the kind of the part, or on parts of one kind only. */
export type KeyContext = "score" | PartKind;

interface BindingKeys {
  context: KeyContext;
  /** The keys, on every platform unless `mac` says otherwise; the first is the one shown (`formatChord`). */
  keys: readonly Chord[];
  /**
   * The keys on a Mac, where they are not those of `keys`: a Mac has no `Insert` key, some keys
   * of Windows are the browser's on a Mac (keymap.md, 1.3), and a Mac's delete key is Backspace.
   */
  mac?: readonly Chord[];
  /**
   * The keys as keymap.md writes them for each platform, for the tests: modifiers by the name on
   * the keyboard (`Ctrl`, `Alt`, `Shift`, `Win`; on a Mac `Ctrl`, `Option`, `Shift`, `Cmd`) and
   * the key by its `code`, as in `"Cmd+Shift+KeyZ"`.
   */
  keymap: Record<KeyPlatform, readonly string[]>;
}

/** A key the session handles: the shell then calls `preventDefault`. */
export interface SessionBinding extends BindingKeys {
  effect: SessionEffect;
  native?: undefined;
  page?: undefined;
  /** Held down, the key's auto-repeat runs it again: moves, `+` and `-` only (keymap.md, 1.1). */
  repeat?: true;
  /** The fret a digit writes. */
  value?: number;
}

/** A key left to the browser: it is not `preventDefault`-ed, so that the browser fires its event. */
export interface NativeBinding extends BindingKeys {
  effect: NativeEffect;
  native: true;
  page?: undefined;
}

/** A key the session leaves to the page, which does what it is for (`pageEffectOf`). */
export interface PageBinding extends BindingKeys {
  effect: PageEffect;
  native?: undefined;
  page: true;
  value?: undefined;
}

export type KeyBinding = SessionBinding | NativeBinding | PageBinding;

const DIGITS = [..."0123456789"];
const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** The keys of the browser's tabs and windows, with Ctrl or Cmd, and Shift or not. */
const TAB_KEYS = ["KeyT", "KeyW", "KeyN"].flatMap((code) => [code, `Shift+${code}`]);

/** The keys of the browser's zoom, with Ctrl or Cmd. */
const ZOOM_KEYS = ["Equal", "Shift+Equal", "NumpadAdd", "Minus", "NumpadSubtract", "Digit0", "Numpad0"];

/** The same keys on both platforms. */
const both = (...keys: string[]): Record<KeyPlatform, readonly string[]> => ({ other: keys, mac: keys });

export const KEY_BINDINGS: readonly KeyBinding[] = [
  // Section 2: the keys of every kind of part.
  { effect: "nextBeat", context: "score", keys: ["ArrowRight"], repeat: true, keymap: both("ArrowRight") },
  { effect: "previousBeat", context: "score", keys: ["ArrowLeft"], repeat: true, keymap: both("ArrowLeft") },
  { effect: "lineDown", context: "score", keys: ["ArrowDown"], repeat: true, keymap: both("ArrowDown") },
  { effect: "lineUp", context: "score", keys: ["ArrowUp"], repeat: true, keymap: both("ArrowUp") },
  // Selecting (docs/spec/commands.md, section 4): Shift extends a beat range, Shift with Nav a bar range.
  { effect: "selectNextBeat", context: "score", keys: ["Shift+ArrowRight"], repeat: true, keymap: both("Shift+ArrowRight") },
  { effect: "selectPreviousBeat", context: "score", keys: ["Shift+ArrowLeft"], repeat: true, keymap: both("Shift+ArrowLeft") },
  { effect: "selectNextBar", context: "score", keys: ["Nav+Shift+ArrowRight"], repeat: true, keymap: { other: ["Ctrl+Shift+ArrowRight"], mac: ["Option+Shift+ArrowRight"] } },
  { effect: "selectPreviousBar", context: "score", keys: ["Nav+Shift+ArrowLeft"], repeat: true, keymap: { other: ["Ctrl+Shift+ArrowLeft"], mac: ["Option+Shift+ArrowLeft"] } },
  { effect: "deselect", context: "score", keys: ["Escape"], keymap: both("Escape") },
  { effect: "insertBeat", context: "score", keys: ["Insert"], mac: ["Alt+Enter"], keymap: { other: ["Insert"], mac: ["Option+Enter"] } },
  // The key marked delete on a Mac keyboard sends Backspace, and comes first there; Fn+delete sends Delete.
  { effect: "delete", context: "score", keys: ["Delete", "Backspace"], mac: ["Backspace", "Delete"], keymap: both("Delete", "Backspace") },
  // `+` is Shift+= on most keyboards: with or without Shift.
  { effect: "shorter", context: "score", keys: ["Equal", "Shift+Equal", "NumpadAdd"], repeat: true, keymap: both("Equal", "Shift+Equal", "NumpadAdd") },
  { effect: "longer", context: "score", keys: ["Minus", "NumpadSubtract"], repeat: true, keymap: both("Minus", "NumpadSubtract") },
  { effect: "undo", context: "score", keys: ["Mod+KeyZ"], keymap: { other: ["Ctrl+KeyZ"], mac: ["Cmd+KeyZ"] } },
  // Not Cmd+Y on a Mac: it is the history of Safari and Chrome.
  { effect: "redo", context: "score", keys: ["Mod+KeyY", "Mod+Shift+KeyZ"], mac: ["Mod+Shift+KeyZ"], keymap: { other: ["Ctrl+KeyY", "Ctrl+Shift+KeyZ"], mac: ["Cmd+Shift+KeyZ"] } },
  // Windows' older Shift+Delete and Shift+Insert fire the same events; a Mac has neither.
  { effect: "copy", context: "score", keys: ["Mod+KeyC"], native: true, keymap: { other: ["Ctrl+KeyC"], mac: ["Cmd+KeyC"] } },
  { effect: "cut", context: "score", keys: ["Mod+KeyX", "Shift+Delete"], mac: ["Mod+KeyX"], native: true, keymap: { other: ["Ctrl+KeyX", "Shift+Delete"], mac: ["Cmd+KeyX"] } },
  { effect: "paste", context: "score", keys: ["Mod+KeyV", "Shift+Insert"], mac: ["Mod+KeyV"], native: true, keymap: { other: ["Ctrl+KeyV", "Shift+Insert"], mac: ["Cmd+KeyV"] } },
  { effect: "playPause", context: "score", keys: ["Space"], page: true, keymap: both("Space") },
  // Section 4.1: a digit on the row of digits or on the numeric keypad.
  ...DIGITS.map((digit): SessionBinding => {
    const keys = [`Digit${digit}`, `Numpad${digit}`];
    return { effect: "fret", value: Number(digit), context: "fretted", keys, keymap: both(...keys) };
  }),
];

/**
 * The keys no binding may be on (keymap.md, 1.2): the operating system takes them first, the
 * browser cannot be kept from them, or they take the focus away. Written as `KeyBinding.keymap`
 * is; `*` stands for any key with those modifiers held, and any others besides.
 */
export const FORBIDDEN_KEYS: Record<KeyPlatform, readonly string[]> = {
  other: [
    ...TAB_KEYS.map((key) => `Ctrl+${key}`),
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
    ...ZOOM_KEYS.map((key) => `Ctrl+${key}`),
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
    ...TAB_KEYS.map((key) => `Cmd+${key}`),
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
    ...ZOOM_KEYS.map((key) => `Cmd+${key}`),
    ...["I", "J", "C", "U"].map((letter) => `Cmd+Option+Key${letter}`),
    "Ctrl+Cmd+KeyF",
    // Option with a letter types a character, or is a dead key: a Mac binds none (keymap.md, 1.2).
    // F1-F12 without Fn are the Mac's own keys too, but not here: a page cannot tell them from
    // Fn with a function key, which sends the same code; what a function key does on a Mac has a
    // toolbar button as well (keymap.md, 1.2).
    ...LETTERS.map((letter) => `Option+Key${letter}`),
  ],
};
