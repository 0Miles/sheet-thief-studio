// Every icon the interface names is bundled (src/icons.ts): one that is not would not be drawn,
// since nothing is fetched from the icon service.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import { h, render } from "vue";

import { Icon, isBundled, MATERIAL_SYMBOLS } from "../src/icons";

/**
 * Strings of the shape `prefix:name` that are no icons: the events of `v-model` and the key of
 * the remembered colour scheme. A new one that is no icon either is added here, knowingly.
 */
const NOT_ICONS = /^(update|karyl):/;

/**
 * The icons named in the sources below `directory`: whatever string is given to an `icon` attribute,
 * property or default (not the bound ones, `:icon="…"`, whose names are made as the page runs), and any other quoted string of the shape `prefix:name`, of whatever icon set.
 */
function iconsNamedIn(directory: string): string[] {
  const names = new Set<string>();
  for (const entry of readdirSync(directory, { recursive: true, encoding: "utf8" })) {
    if (!/\.(vue|ts)$/.test(entry) || entry.split(/[\\/]/).includes("node_modules")) continue;
    const source = readFileSync(join(directory, entry), "utf8");
    for (const [, name] of source.matchAll(/(?<![:\w.-])icon\s*[=:]\s*["']([^"']+)["']/g)) names.add(name!);
    for (const [, name] of source.matchAll(/["']([a-z][a-z0-9]*(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*)["']/g)) if (!NOT_ICONS.test(name!)) names.add(name!);
  }
  return [...names].sort();
}

/** What the icon component draws for this name. */
function drawn(icon: string): string {
  const host = document.createElement("div");
  render(h(Icon, { icon }), host);
  return host.innerHTML;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("every icon the app and @karyl-chan/ui name is bundled", () => {
  const named = [
    // From apps/web, where its tests run.
    ...iconsNamedIn(resolve("src")),
    ...iconsNamedIn(resolve("node_modules/@karyl-chan/ui/src")),
  ];
  // The UI kit does name some: a search that finds none is looking in the wrong place.
  expect(named.length).toBeGreaterThan(0);
  expect(named.filter((name) => !isBundled(name))).toEqual([]);
});

test("an icon of another set, or one that is not bundled, is not taken for a bundled one", () => {
  expect(Object.keys(MATERIAL_SYMBOLS.icons).every((name) => isBundled(`material-symbols:${name}`))).toBe(true);
  for (const name of ["material-symbols:home", "mdi:close-rounded", "heroicons:x-mark", "close-rounded", "material-symbols:toString"]) {
    expect([name, isBundled(name)]).toEqual([name, false]);
  }
});

test("an icon asked for by a name that is not bundled is reported as an error, once; a bundled one is drawn", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  expect(drawn("material-symbols:close-rounded")).toContain("<svg");
  expect(error).not.toHaveBeenCalled();

  expect(drawn("carbon:not-bundled")).not.toContain("<svg");
  drawn("carbon:not-bundled");
  expect(error).toHaveBeenCalledTimes(1);
  expect(error.mock.calls[0]![0]).toContain("carbon:not-bundled");
});
