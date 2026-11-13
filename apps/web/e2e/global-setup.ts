// Before the end-to-end tests: an empty, migrated database holding only the test accounts.
// The server's own script does it, so that the web app never imports the server.
import { spawnSync } from "node:child_process";

import { ACCOUNTS, SERVER_ENV } from "./environment";

export default function globalSetup(): void {
  const seeded = spawnSync("pnpm", ["--filter", "@studio/server", "seed:e2e"], {
    input: JSON.stringify(ACCOUNTS),
    env: { ...process.env, ...SERVER_ENV },
    stdio: ["pipe", "inherit", "inherit"],
    shell: process.platform === "win32",
  });
  if (seeded.status !== 0) throw new Error("Could not prepare the end-to-end database: is compose.dev.yaml up?");
}
