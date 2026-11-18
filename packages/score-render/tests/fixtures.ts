/// <reference types="node" />
// The sample files of the import and export tests (tests/fixtures, README.md there). Node's types
// are for the tests that read them only: the package itself runs in the browser.
import { readFileSync } from "node:fs";

/** The bytes of a file in tests/fixtures. */
export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}
