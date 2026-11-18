// The platform layer (docs/spec/keymap.md, 1.3): which keys a binding is on each platform, and
// how they are named.
import { describe, expect, test } from "vitest";

import { FORBIDDEN_KEYS, KEY_BINDINGS, type KeyBinding, type SessionBinding } from "../src/bindings";
import {
  chordsOf,
  comboName,
  comboOf,
  detectKeyPlatform,
  formatChord,
  type KeyCombo,
  keyNameOf,
  type KeyPlatform,
  matchKey,
  type ModifierFlag,
  resolveChord,
} from "../src/keys";

const PLATFORMS: KeyPlatform[] = ["other", "mac"];
const MODIFIER_FLAGS: ModifierFlag[] = ["ctrlKey", "altKey", "shiftKey", "metaKey"];

/** Each key of a binding on a platform. */
const combosOf = (binding: KeyBinding, platform: KeyPlatform): KeyCombo[] => chordsOf(binding, platform).map((chord) => resolveChord(chord, platform));
const nameOf = (binding: KeyBinding) => `${binding.effect}${binding.fret ?? ""}${binding.piece === undefined ? "" : ` ${binding.piece}`}${binding.letter ?? ""} (${binding.context})`;
/** Two contexts that can be in force at once: the score's keys work on every kind of part, and none of them in a text box. */
const overlap = (a: KeyBinding, b: KeyBinding) => a.context === b.context || ((a.context === "score" || b.context === "score") && a.context !== "textEntry" && b.context !== "textEntry");

test.each([
  [{ userAgentData: { platform: "macOS" } }],
  [{ platform: "MacIntel" }],
  [{ platform: "iPad" }],
  [{ platform: "iPhone" }],
  [{ platform: "iPod touch" }],
  [{ platform: "", userAgentData: { platform: "macOS" } }],
])("%o is a Mac", (nav) => {
  expect(detectKeyPlatform(nav)).toBe("mac");
});

test.each([
  [{ platform: "Win32" }],
  [{ platform: "Linux x86_64" }],
  [{ userAgentData: { platform: "Windows" } }],
  [{ userAgentData: { platform: "Chrome OS" }, platform: "Linux x86_64" }],
  [{ userAgentData: {} }],
  [{}],
])("%o is not a Mac", (nav) => {
  expect(detectKeyPlatform(nav)).toBe("other");
});

test.each([
  ["Mod+KeyZ", "Ctrl+Z", "⌘Z"],
  ["Mod+Shift+KeyZ", "Ctrl+Shift+Z", "⇧⌘Z"],
  ["Nav+ArrowRight", "Ctrl+→", "⌥→"],
  ["Nav+Shift+ArrowLeft", "Ctrl+Shift+←", "⌥⇧←"],
  ["Alt+Digit1", "Alt+1", "⌥1"],
  ["Alt+Enter", "Alt+Enter", "⌥↩"],
  ["Mod+Backspace", "Ctrl+Backspace", "⌘⌫"],
  ["Delete", "Delete", "⌦"],
  ["Shift+KeyL", "Shift+L", "⇧L"],
  ["Numpad5", "Num 5", "Num 5"],
  ["Minus", "-", "-"],
  ["Equal", "+", "+"],
  // + is Shift and the key of =: it is named once, not Shift++ or ⇧+.
  ["Shift+Equal", "+", "+"],
  ["Period", ".", "."],
  ["Home", "Home", "Home"],
  ["F8", "F8", "F8"],
])("%s is named %s on Windows and Linux, %s on a Mac", (chord, other, mac) => {
  expect(formatChord(chord, "other")).toBe(other);
  expect(formatChord(chord, "mac")).toBe(mac);
});

test.each([
  ["undo", undefined, "Ctrl+Z", "⌘Z"],
  ["redo", undefined, "Ctrl+Y", "⇧⌘Z"],
  ["nextBar", undefined, "Ctrl+→", "⌥→"],
  ["previousStaff", undefined, "Ctrl+↑", "⌥↑"],
  ["secondVoice", undefined, "Alt+2", "⌥2"],
  ["insertBeat", undefined, "Insert", "⌥↩"],
  ["delete", undefined, "Delete", "⌫"],
  ["shorter", undefined, "+", "+"],
  ["triplet", undefined, "Shift+T", "⇧T"],
  ["dynamic", undefined, "Shift+F", "⇧F"],
  ["text", undefined, "Enter", "↩"],
  ["cancelEntry", undefined, "Esc", "Esc"],
  ["fret", 7, "7", "7"],
  ["copy", undefined, "Ctrl+C", "⌘C"],
  ["playPause", undefined, "Space", "Space"],
  ["insertBarBefore", undefined, "Ctrl+Insert", "⌘↩"],
  ["insertBarAfter", undefined, "Ctrl+Shift+Insert", "⇧⌘↩"],
  ["deleteBars", undefined, "Ctrl+Delete", "⌘⌫"],
  ["barPanel", undefined, "F2", "F2"],
] as const)("the key of %s %s is shown as %s on Windows and Linux, %s on a Mac", (effect, fret, other, mac) => {
  expect(keyNameOf(effect, "other", fret)).toBe(other);
  expect(keyNameOf(effect, "mac", fret)).toBe(mac);
});

test("a key that is not in the keymap has no name: a digit without its fret, or a fret no digit writes", () => {
  expect(() => keyNameOf("fret", "other")).toThrow(/fret/);
  expect(() => keyNameOf("fret", "other", 12)).toThrow(/fret12/);
});

test("each digit names the fret it writes, and a binding of the fret effect cannot be written without one", () => {
  const digits = KEY_BINDINGS.filter((binding) => binding.effect === "fret");
  expect(digits.map((binding) => [binding.fret, binding.keys])).toEqual([..."0123456789"].map((digit) => [Number(digit), [`Digit${digit}`, `Numpad${digit}`]]));
  // @ts-expect-error: a fret key without its fret would write fret 0.
  const missing: SessionBinding = { effect: "fret", context: "fretted", keys: ["Digit1"], keymap: { other: ["Digit1"], mac: ["Digit1"] } };
  expect(missing.fret).toBeUndefined();
});

test("a chord with a modifier the layer does not know is a mistake in the table", () => {
  expect(() => formatChord("Ctrl+KeyZ", "other")).toThrow(/Ctrl/);
  expect(() => formatChord("Shift+Mod+KeyZ", "other")).toThrow(/order/);
});

describe.each(PLATFORMS)("on %s", (platform) => {
  test.each(KEY_BINDINGS.map((binding) => [nameOf(binding), binding] as const))("%s is on the keys keymap.md gives it", (_, binding) => {
    const keys = combosOf(binding, platform).map((combo) => comboName(combo, platform));
    const documented = binding.keymap[platform].map((text) => comboName(comboOf(text, platform), platform));
    expect(keys.sort()).toEqual(documented.sort());
  });

  test.each(KEY_BINDINGS.map((binding) => [nameOf(binding), binding] as const))("%s is on no key the platform keeps for itself", (_, binding) => {
    const forbidden = FORBIDDEN_KEYS[platform].map((text) => comboOf(text, platform));
    for (const combo of combosOf(binding, platform)) {
      const name = comboName(combo, platform);
      const taken = forbidden.find((entry) => (entry.code === "*" ? MODIFIER_FLAGS.every((flag) => !entry[flag] || combo[flag]) : comboName(entry, platform) === name));
      expect(taken && `${name} is kept by the platform (${comboName(taken, platform)})`).toBeUndefined();
    }
  });

  test("every key is named without a doubled + or a + of its own after a modifier", () => {
    const names = KEY_BINDINGS.flatMap((binding) => chordsOf(binding, platform).map((chord) => formatChord(chord, platform)));
    expect(names.filter((name) => /\+\+|[⌃⌥⇧⌘]\+/.test(name))).toEqual([]);
  });

  test("no two bindings that can be in force at once are on the same key", () => {
    const keys = KEY_BINDINGS.flatMap((binding) => combosOf(binding, platform).map((combo) => ({ name: comboName(combo, platform), binding })));
    const clashes = keys.flatMap((a, index) =>
      keys
        .slice(index + 1)
        .filter((b) => b.name === a.name && b.binding !== a.binding && overlap(a.binding, b.binding))
        .map((b) => `${a.name}: ${nameOf(a.binding)} and ${nameOf(b.binding)}`),
    );
    expect(clashes).toEqual([]);
  });

  test.each(KEY_BINDINGS.map((binding) => [nameOf(binding), binding] as const))("%s is not run with one more modifier held", (_, binding) => {
    const own = new Set(combosOf(binding, platform).map((combo) => comboName(combo, platform)));
    const kind = binding.context === "score" ? undefined : binding.context;
    for (const combo of combosOf(binding, platform)) {
      expect(matchKey(combo, platform, kind)).toBe(binding);
      for (const flag of MODIFIER_FLAGS) {
        const more = { ...combo, [flag]: true };
        if (combo[flag] || own.has(comboName(more, platform))) continue;
        expect(matchKey(more, platform, kind), comboName(more, platform)).not.toBe(binding);
      }
    }
  });
});
