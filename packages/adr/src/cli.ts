#!/usr/bin/env node
import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(version);
  process.exit(0);
}

console.error(`adr ${version}: not implemented yet (see docs/01-adr-v1.md)`);
process.exit(2);
