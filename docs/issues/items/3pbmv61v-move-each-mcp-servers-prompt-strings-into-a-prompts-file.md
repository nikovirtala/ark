# Move each MCP server's prompt strings into a prompts file

## Goal
Each package's server instructions, every tool and argument description and the known-issue line template live in one file, `packages/<p>/src/mcp/prompts.ts`, so the frame path in `CODEOWNERS` gates every change to text consuming agents read as a prompt (docs/05-factory-v1.md, Frame routing).

## Notes
Today the instructions are a constant in each `server.ts` and the descriptions sit inline in `tools.ts`, `read-tools.ts` and `write-tools.ts`. Result texts (`text.ts`) and error messages stay where they are; the design lists them as left over under S2. The change moves strings only: no wording changes, so the existing MCP tests pass unchanged.

## Done when
- adr, issues and ledger each have `src/mcp/prompts.ts` holding their server instructions and every tool and argument description; the strings are byte for byte the same as before.
- `.github/CODEOWNERS` names Niko for `/packages/*/src/mcp/prompts.ts`.
- A lint rule run by `check` fails on an `instructions` or `description` string literal passed to an MCP tool or server outside a prompts file, and a test shows it failing on such a literal.
- `pnpm test` passes on the branch tip.
