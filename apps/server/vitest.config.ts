import { defineConfig } from "vitest/config";

// The test files of a run share one Postgres database and one Redis database, the run's own
// (another run at once has others): the database is made and migrated once for the run
// (tests/globalSetup.ts), and each file empties both before it starts (tests/support.ts). Run the
// files one after another, so that none empties what another uses.
export default defineConfig({
  test: {
    globalSetup: ["./tests/globalSetup.ts"],
    fileParallelism: false,
  },
});
