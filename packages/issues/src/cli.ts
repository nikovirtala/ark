#!/usr/bin/env node
import { createRequire } from "node:module";
import { processIO, runCli } from "@nikovirtala/ledger/cli";
import { issuesCli } from "./cli/commands.js";

// Read at run time, relative to dist/cli.js (or src/cli.ts): both sit next to ../package.json.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

process.exitCode = await runCli(issuesCli(version), processIO());
