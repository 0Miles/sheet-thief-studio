import { defineConfig } from "vitest/config";

// The test files share one Postgres database and one Redis database, and each empties them
// before it starts (tests/support.ts): run the files one after another.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
