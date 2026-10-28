import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    // Tests share one Postgres database, so run files serially.
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
