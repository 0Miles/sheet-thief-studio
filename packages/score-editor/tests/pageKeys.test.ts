// The keys the page handles rather than the session: Space plays and pauses (docs/spec/keymap.md,
// section 2; docs/spec/playback.md, section 4).
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
