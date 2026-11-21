#!/usr/bin/env node
/** The `deploy` binary. The commands are in commands.ts. */
import { runDeployCli } from "./commands.js";

runDeployCli(process.argv.slice(2), {
  out: (t) => console.log(t),
  err: (t) => console.error(t),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  },
);
