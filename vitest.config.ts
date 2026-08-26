import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./tests/setup.ts"],

    // ── The single most important setting in this file ──────────────────────
    // Test files share ONE physical database and truncate it between cases.
    // Run them in parallel and file A's truncate deletes file B's fixtures
    // mid-assertion, producing failures that move around between runs and
    // look like flaky code rather than a broken harness.
    //
    // The alternative — a database per worker — is worth doing if the suite
    // ever gets slow enough to care. It is not close to that yet, and a
    // correct slow suite beats a fast unreliable one.
    fileParallelism: false,
    sequence: { concurrent: false },

    hookTimeout: 30_000,
    testTimeout: 20_000,
    include: ["tests/**/*.test.ts"],
  },

  resolve: {
    // Mirrors the "@/*" path alias in tsconfig.json. Done by hand rather than
    // via vite-tsconfig-paths so the test harness adds no dependency.
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
