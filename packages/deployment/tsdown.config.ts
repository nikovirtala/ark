import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    testing: "src/testing/index.ts",
    // Runs a TypeScript deployment task in its own process (src/tasks/protocol.ts finds it next to
    // the bundle that starts it).
    "task-shim": "src/tasks/task-shim.ts",
  },
  format: "esm",
  platform: "node",
  target: "node24",
  // Declarations come from `tsc -b` (dist/types), which already ran: keep them. Clean only the
  // bundles, so stale hashed chunks from earlier builds are never packed.
  dts: false,
  clean: ["dist/*.js", "dist/*.js.map"],
  fixedExtension: false,
  sourcemap: true,
});
