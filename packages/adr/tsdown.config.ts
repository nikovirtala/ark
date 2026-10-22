import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { index: "src/index.ts", kind: "src/kind.ts", cli: "src/cli.ts" },
  format: "esm",
  platform: "node",
  target: "node24",
  // Declarations come from `tsc -b` (dist/types), which already ran: keep them.
  dts: false,
  clean: false,
  fixedExtension: false,
  sourcemap: true,
});
