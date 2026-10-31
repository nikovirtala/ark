# Share the MCP schema and argument helpers in ledger/mcp

## Goal
Move the MCP input schemas, the argument readers and the resource id guard that adr's and issues' MCP servers copy from each other into `ledger/mcp`, so both servers validate the same inputs with one copy.

## Notes
Candidate 9 of ?29's comparison, recommended "lift later": pick this up with the next change to either MCP server. The copies haven't drifted, so nothing is wrong until then.

- Verbatim in both tools, about 50 lines: `ID`, `TEXT`, `SECTIONS`, `GLOBS`, `SOURCE`, `object`, `READ`, `WRITE`, `str`, `strings` and `doc` (`packages/adr/src/mcp/tools.ts:55-94`, `packages/issues/src/mcp/tools.ts:13-87`), and the resource template's id-length guard with its not-found handling (`packages/adr/src/mcp/resources.ts:44`, `packages/issues/src/mcp/resources.ts:64`).
- ?12 already makes both `SOURCE` schemas use the shared source-name pattern, so this lift only moves the `SOURCE` constant into `ledger/mcp`. That is why it depends on ?12.
- The resource guard becomes `checkResourceId(id, noun)`, which throws `invalid <noun> "…": an id or number is at most MAX_ID characters` as both servers do now.
- Placement: `packages/ledger/src/mcp/` (layer 15), exported from `ledger/mcp` (`mcp/index.ts`). Only `mcp/` may import the MCP SDK, so these helpers can't go anywhere else.
- Tool descriptions, policy and the tool lists stay in each tool.
- Document the new exports in `packages/ledger/README.md`.

## Done when
- `ledger/mcp` exports the schema helpers, the argument readers and the resource id guard, with unit tests.
- adr's and issues' MCP tools and resources use them, and no copy remains in either tool.
- Both tools' MCP tests pass with no change to what they assert.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
