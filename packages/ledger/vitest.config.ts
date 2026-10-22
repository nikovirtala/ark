import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Git-backed tests spawn many short git processes.
    testTimeout: 30_000,
  },
});
