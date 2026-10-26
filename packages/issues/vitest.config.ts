import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // The property suites fold hundreds of generated logs; under a full parallel run they need
    // more than the default 5 seconds.
    testTimeout: 60_000,
  },
});
