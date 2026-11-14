// The platform layer of the keymap (docs/spec/keymap.md, 1.3): the keys are written as abstract
// chords, which become the keys of Windows and Linux, or of macOS, here and nowhere else.
import type { PartKind } from "@studio/score-model";

import { KEY_BINDINGS, type KeyBinding, type PageEffect, type TextEntryEffect } from "./bindings";

/** The keys of Windows and Linux (`"other"`), or of macOS and iPadOS (`"mac"`). */
export type KeyPlatform = "mac" | "other";

/** The part of a `navigator` the platform is told from: the page passes `navigator` itself. */
export interface NavigatorLike {
  platform?: string;
  userAgentData?: { platform?: string };
}

/**
 * Which keys this browser's keyboard has: the one place in the project that tells the platform.
 * iPadOS reports `MacIntel`, and an iPad with a keyboard uses `Cmd` as a Mac does.
 */
export function detectKeyPlatform(nav: NavigatorLike): KeyPlatform {
  if (nav.userAgentData?.platform === "macOS") return "mac";
  return /^(Mac|iPhone|iPad|iPod)/.test(nav.platform ?? "") ? "mac" : "other";
}

/** The modifiers a chord is written with, in the order they are written (keymap.md, 1.3). */
const MODIFIERS = ["Mod", "Nav", "Alt", "Shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

/**
 * A key as the keymap writes it: abstract modifiers, in the order `Mod`, `Nav`, `Alt`, `Shift`,
 * then a `KeyboardEvent.code`, joined with `+`: `"Mod+Shift+KeyZ"`, `"Nav+ArrowLeft"`, `"Digit5"`.
 */
export type Chord = string;

/** The keys a chord is on one platform: the modifiers held, exactly, and where the key is. */
export interface KeyCombo {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/** A modifier as a keyboard event tells it. */
export type ModifierFlag = Exclude<keyof KeyCombo, "code">;

/**
 * Keys written as modifiers and a `code` joined with `+`, each modifier read by `flagOf`, which
 * throws on one it does not know.
 */
function readKeys(text: string, flagOf: (modifier: string) => ModifierFlag): KeyCombo {
  const parts = text.split("+");
  const combo: KeyCombo = { code: parts.pop()!, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
  for (const part of parts) combo[flagOf(part)] = true;
  return combo;
}

/** What each abstract modifier holds on each platform. */
const HELD: Record<KeyPlatform, Record<Modifier, ModifierFlag>> = {
  other: { Mod: "ctrlKey", Nav: "ctrlKey", Alt: "altKey", Shift: "shiftKey" },
  mac: { Mod: "metaKey", Nav: "altKey", Alt: "altKey", Shift: "shiftKey" },
};

/** The keys of a chord on a platform. */
export function resolveChord(chord: Chord, platform: KeyPlatform): KeyCombo {
  let last = -1;
  return readKeys(chord, (part) => {
    const index = MODIFIERS.indexOf(part as Modifier);
    if (index < 0) throw new Error(`${chord}: ${part} is not one of ${MODIFIERS.join(", ")}`);
    if (index <= last) throw new Error(`${chord}: the modifiers are written in the order ${MODIFIERS.join(", ")}`);
    last = index;
    return HELD[platform][part as Modifier];
  });
}

/** The keys of a binding on a platform. */
export function chordsOf(binding: KeyBinding, platform: KeyPlatform): readonly Chord[] {
  return (platform === "mac" ? binding.mac : undefined) ?? binding.keys;
}

/**
 * The modifiers by the names on each platform's keyboard, in the order they are named, which on
 * a Mac is Apple's (⌃⌥⇧⌘), with the symbols a Mac shows them with.
 */
const KEYBOARD_NAMES: Record<KeyPlatform, [name: string, flag: ModifierFlag, symbol?: string][]> = {
  other: [
    ["Ctrl", "ctrlKey"],
    ["Alt", "altKey"],
    ["Shift", "shiftKey"],
    ["Win", "metaKey"],
  ],
  mac: [
    ["Ctrl", "ctrlKey", "⌃"],
    ["Option", "altKey", "⌥"],
    ["Shift", "shiftKey", "⇧"],
    ["Cmd", "metaKey", "⌘"],
  ],
};

/** The names of the keys whose name is not their `code`, by platform where they differ. */
const KEY_NAMES: Record<string, string | Record<KeyPlatform, string>> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: { other: "Enter", mac: "↩" },
  Backspace: { other: "Backspace", mac: "⌫" },
  Delete: { other: "Delete", mac: "⌦" },
  Escape: "Esc",
  // The key the keymap calls `+`: = and, with Shift, +.
  Equal: "+",
  Minus: "-",
  Period: ".",
  Comma: ",",
  BracketLeft: "[",
  BracketRight: "]",
  Backquote: "`",
  NumpadAdd: "Num +",
  NumpadSubtract: "Num -",
  NumpadDecimal: "Num .",
};

function keyName(code: string, platform: KeyPlatform): string {
  const named = KEY_NAMES[code];
  if (named !== undefined) return typeof named === "string" ? named : named[platform];
  const letterOrDigit = /^(?:Key|Digit)(.)$/.exec(code);
  if (letterOrDigit) return letterOrDigit[1]!;
  const numpad = /^Numpad(\d)$/.exec(code);
  return numpad ? `Num ${numpad[1]}` : code;
}

/**
 * How a chord is shown on this platform, in a toolbar's hint or a help text: `Ctrl+Z` on Windows
 * and Linux, `⌘Z` on a Mac.
 */
export function formatChord(chord: Chord, platform: KeyPlatform): string {
  const combo = resolveChord(chord, platform);
  // `+` is Shift and the key of =, and is named `+` with or without it: not `Shift++`.
  const held = KEYBOARD_NAMES[platform].filter(([, flag]) => combo[flag] && !(flag === "shiftKey" && combo.code === "Equal"));
  const key = keyName(combo.code, platform);
  return platform === "mac" ? held.map(([, , symbol]) => symbol).join("") + key : [...held.map(([name]) => name), key].join("+");
}

/**
 * How the key of an effect is shown on this platform (`formatChord`), in a toolbar's hint or a
 * help text: the first key of its binding, `Ctrl+Z` or `⌘Z` for undo. A digit's binding is told
 * by the fret it writes. Throws for an effect no binding has: a mistake in the table.
 */
export function keyNameOf(effect: KeyBinding["effect"], platform: KeyPlatform, fret?: number): string {
  const binding = KEY_BINDINGS.find((each) => each.effect === effect && each.fret === fret);
  const chord = binding && chordsOf(binding, platform)[0];
  if (chord === undefined) throw new Error(`no key ${effect}${fret ?? ""} in the keymap`);
  return formatChord(chord, platform);
}

/**
 * The keys written with the modifiers on the platform's keyboard, as the keymap's tables are:
 * `"Ctrl+Shift+KeyZ"`, `"Cmd+Enter"`, `"Option+ArrowLeft"`.
 */
export function comboOf(text: string, platform: KeyPlatform): KeyCombo {
  return readKeys(text, (part) => {
    const held = KEYBOARD_NAMES[platform].find(([name]) => name === part);
    if (held === undefined) throw new Error(`${text}: ${part} is not a modifier of ${platform}`);
    return held[1];
  });
}

/** The keys named as `comboOf` reads them, the modifiers always in the same order. */
export function comboName(combo: KeyCombo, platform: KeyPlatform): string {
  return [...KEYBOARD_NAMES[platform].filter(([, flag]) => combo[flag]).map(([name]) => name), combo.code].join("+");
}

/** The part of a keyboard event the keymap reads: a `KeyboardEvent` is one. */
export interface Key {
  /**
   * `KeyboardEvent.code`: where the key is on the keyboard, whatever the layout or the input
   * method. Every key is matched on it (docs/spec/keymap.md, 1.1).
   */
  code: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
  /** The key is held down and this is its auto-repeat. */
  repeat?: boolean;
  /** The key goes to an input method. */
  isComposing?: boolean;
  keyCode?: number;
}

/** The bindings by their keys, on each platform. */
const bindingsByKeys = new Map<KeyPlatform, Map<string, KeyBinding[]>>();

function bindingsOn(platform: KeyPlatform): Map<string, KeyBinding[]> {
  let byKeys = bindingsByKeys.get(platform);
  if (byKeys === undefined) {
    byKeys = new Map();
    for (const binding of KEY_BINDINGS) {
      for (const chord of chordsOf(binding, platform)) {
        const name = comboName(resolveChord(chord, platform), platform);
        const bindings = byKeys.get(name);
        if (bindings === undefined) byKeys.set(name, [binding]);
        else bindings.push(binding);
      }
    }
    bindingsByKeys.set(platform, byKeys);
  }
  return byKeys;
}

/**
 * The binding a key runs on this platform, on a part of this kind (none: the part's kind cannot
 * be read), or in a text box of the score (`"textEntry"`), where the keys of the score are not.
 * The modifiers must be exactly the binding's: one more held, and it is not that key (keymap.md,
 * 1.1). A key that goes to an input method is no binding's: Safari ends a composition with a
 * keydown whose `isComposing` is false and whose `keyCode` is 229.
 */
export function matchKey(key: Key, platform: KeyPlatform, kind: PartKind | "textEntry" | undefined): KeyBinding | undefined {
  if (key.isComposing === true || key.keyCode === 229) return undefined;
  const combo: KeyCombo = { code: key.code, ctrlKey: key.ctrlKey === true, altKey: key.altKey === true, shiftKey: key.shiftKey === true, metaKey: key.metaKey === true };
  return bindingsOn(platform)
    .get(comboName(combo, platform))
    ?.find((binding) => binding.context === kind || (binding.context === "score" && kind !== "textEntry"));
}

/**
 * What a key does that the page handles, not the session (which leaves it alone): null when it
 * is no such key. Matched as every key is (`matchKey`); these work on every kind of part.
 */
export function pageEffectOf(key: Key, platform: KeyPlatform): PageEffect | null {
  const binding = matchKey(key, platform, undefined);
  return binding?.page ? binding.effect : null;
}

/**
 * What a key does in a text box of the score, such as the text of a beat (keymap.md, section 6):
 * null for every other key, which is the box's own. The key with which an input method ends a
 * composition, a word chosen with Enter among them, is null too (`matchKey`): it saves nothing.
 */
export function textEntryEffectOf(key: Key, platform: KeyPlatform): TextEntryEffect | null {
  const binding = matchKey(key, platform, "textEntry");
  return binding?.entry ? binding.effect : null;
}
