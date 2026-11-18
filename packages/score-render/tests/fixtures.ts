// The sample files of the import and export tests (tests/fixtures, README.md there). Node's types
// reach the tests only (tests/tsconfig.json): the package itself runs in the browser.
import { readFileSync } from "node:fs";

/** The bytes of a file in tests/fixtures. */
export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}
