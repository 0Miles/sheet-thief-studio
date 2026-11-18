// The keys the page handles rather than the session: Space plays and pauses, F8 goes to the next
// flag (docs/spec/keymap.md, section 2; docs/spec/playback.md, section 4; docs/spec/flags.md,
// section 4).
import { expect, test } from "vitest";

import { type KeyPlatform, pageEffectOf } from "../src/index";
import { keyOf, sessionOn } from "./support";

test.each<KeyPlatform>(["other", "mac"])("on %s, Space plays and pauses, whatever the part, and with a modifier it does not", (platform) => {
  expect(pageEffectOf(keyOf("Space"), platform)).toBe("playPause");
  expect(pageEffectOf(keyOf("Space", { shiftKey: true }), platform)).toBeNull();
  expect(pageEffectOf(keyOf("Space", { ctrlKey: true }), platform)).toBeNull();
  expect(pageEffectOf(keyOf("ArrowRight"), platform)).toBeNull();
  expect(pageEffectOf(keyOf("5"), platform)).toBeNull();
});

test("the Space that ends a composition plays nothing", () => {
  expect(pageEffectOf(keyOf("Space", { isComposing: true }), "other")).toBeNull();
  expect(pageEffectOf(keyOf("Space", { keyCode: 229 }), "mac")).toBeNull();
});

test.each(["fretted", "percussion", "pitched"] as const)("the session leaves Space to the page on a %s part, and the cursor stays", (kind) => {
  const { session, press } = sessionOn(kind);
  const before = session.cursor;
  expect(press("Space")).toBe(false);
  expect(session.cursor).toEqual(before);
});

test.each<KeyPlatform>(["other", "mac"])("on %s, F8 goes to the next flag, with no modifier only, and the session leaves it to the page", (platform) => {
  expect(pageEffectOf(keyOf("F8"), platform)).toBe("nextFlag");
  expect(pageEffectOf(keyOf("F8", { shiftKey: true }), platform)).toBeNull();
  for (const kind of ["fretted", "percussion", "pitched"] as const) {
    const { session, press } = sessionOn(kind);
    const before = session.cursor;
    expect(press("F8")).toBe(false);
    expect(session.cursor).toEqual(before);
  }
});

test.each<KeyPlatform>(["other", "mac"])("on %s, F4 opens and closes the phrase sidebar, with no modifier only, and the session leaves it to the page", (platform) => {
  expect(pageEffectOf(keyOf("F4"), platform)).toBe("phraseSidebar");
  expect(pageEffectOf(keyOf("F4", { shiftKey: true }), platform)).toBeNull();
  for (const kind of ["fretted", "percussion", "pitched"] as const) {
    const { session, press } = sessionOn(kind);
    const before = session.cursor;
    expect(press("F4")).toBe(false);
    expect(session.cursor).toEqual(before);
  }
});
