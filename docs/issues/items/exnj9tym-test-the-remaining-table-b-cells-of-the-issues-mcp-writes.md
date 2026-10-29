# Test the remaining Table B cells of the issues mcp writes

## Goal
Assert, over the in-memory client and the built `issues mcp` over stdio, the cells of the issues agents design §7.3 Table B that the shared cell table `packages/issues/src/test-support/write-cells.ts` leaves out (low finding of the review of issues PR 3c, ?15).

## Notes
- `TABLE_B` in `packages/issues/src/test-support/write-cells.ts` (run by `mcp/write-tools.test.ts` "Table B: the <repo> rows" and `mcp-e2e.test.ts` session W7) has the `issues_close` rows "while close_requires_human is true" and "after mcp_can_close turned false" only with a reason. Table B says those cells are `issue/agent-closed` "+ the reason rules without a reason", so the combination policy refusal × no reason (`issue/agent-closed` and `issue/agent-reason-required`, plus `issue/reason-required` for wontfix) is asserted only by `kind/rules.test.ts`, not over MCP.
- Table B's `issues_start` O cell says "notes unmatched globs" (`planStart`, `packages/issues/src/plan.ts`). The `start` row's O cell is plain `OK` and session W1 starts an issue without scope, so no MCP test checks that note.
- The code already behaves as the table says (the MCP tools pass the kind's findings and the library's notes through unchanged); this is test coverage only.

## Done when
- `TABLE_B` has `issues_close` rows without a reason under `close_requires_human = true` and after `mcp_can_close` turned false, whose O, OB and P cells assert the rules contain `issue/agent-closed` and `issue/agent-reason-required`, and whose closed cells are exactly `transition/illegal`; both suites run them.
- The `issues_start` O cell starts an issue with a glob that matches no tracked file and asserts the note.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
