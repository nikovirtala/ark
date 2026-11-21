import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The task and emulator tests start child processes (Node, the AWS Emulator).
    testTimeout: 30_000,
  },
});
