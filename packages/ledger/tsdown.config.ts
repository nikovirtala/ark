import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts", testing: "src/testing/index.ts", cli: "src/cli/index.ts" },
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
