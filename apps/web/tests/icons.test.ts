// Every icon the interface names is bundled (src/icons.ts): one that is not would not be drawn,
// since nothing is fetched from the icon service.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

import { MATERIAL_SYMBOLS } from "../src/icons";

/** The icons named in the sources below `directory`, as `prefix:name`. */
function iconsNamedIn(directory: string): string[] {
  const names = new Set<string>();
  for (const entry of readdirSync(directory, { recursive: true, encoding: "utf8" })) {
    if (!/\.(vue|ts)$/.test(entry) || entry.split(/[\\/]/).includes("node_modules")) continue;
    for (const [name] of readFileSync(join(directory, entry), "utf8").matchAll(/\b(?:material-symbols|mdi|lucide|tabler|ph|ri)[a-z-]*:[a-z0-9-]+/g)) names.add(name);
  }
  return [...names].sort();
}

test("every icon the app and @karyl-chan/ui name is bundled", () => {
  const named = [
    // From apps/web, where its tests run.
    ...iconsNamedIn(resolve("src")),
    ...iconsNamedIn(resolve("node_modules/@karyl-chan/ui/src")),
  ];
  const bundled = Object.keys(MATERIAL_SYMBOLS.icons).map((name) => `${MATERIAL_SYMBOLS.prefix}:${name}`);
  // The UI kit does name some: a search that finds none is looking in the wrong place.
  expect(named.length).toBeGreaterThan(0);
  expect(named.filter((name) => !bundled.includes(name))).toEqual([]);
});
