# Split the issues MCP tests that sit at their duration share

## Goal
Split packages/issues/src/mcp-e2e.test.ts into its read, write and Table B sessions, and move the Table B rows of packages/issues/src/mcp/write-tools.test.ts into their own file, so no issues test file finishes last and ?19's new TABLE_B rows land in files of their own.

## Notes
- In full 8-core runs, mcp-e2e.test.ts took 168s against a 176s share after the MCP write side landed, 145s against 145s in #46 and 142s against 143s in #47 (AGENTS.md, Test file durations). Alone at 4dbdabf it takes 94s: R1 and R2 6s, W1-W6, W8 and W9 51s, the five W7 Table B tests 36s.
- mcp/write-tools.test.ts took 151s in one full run and 82s alone; its five Table B tests take 33s of that.
- ?19 adds rows to TABLE_B in packages/issues/src/test-support/write-cells.ts, which both files run, so both files would grow.
- Only how the tests are grouped into files changes; no test body changes.

## Done when
- mcp-e2e.test.ts is split into one file each for the read sessions, the write sessions and the Table B sessions, with the shared stdio helpers in test-support, and write-tools.test.ts's Table B tests are in their own file.
- The same tests pass and are skipped as before, and pnpm test:durations reports no file over its share.
- The PR closes this issue with each new file's duration and the issues package's longest file before and after.
