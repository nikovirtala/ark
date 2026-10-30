# Keep adr's and issues' tests from using an outer GIT_DIR

## Summary
With `GIT_DIR` set to another repository, as `git rebase --exec` sets it in a linked worktree,
an adr CLI test and 18 issues MCP tests fail, and they stage files into that repository's index.
So the per-commit check run from a linked worktree fails for every commit that runs adr's or
issues' tests.

## Steps to reproduce
1. At `7945690` (main before this pull request; the files involved are unchanged since), run `pnpm install` and `pnpm build`.
2. Create a throwaway repository: `git init <tmp>`, then `git -C <tmp> commit --allow-empty -m init`.
3. In `packages/adr`, then in `packages/issues`, run
   `GIT_DIR=<tmp>/.git GIT_PREFIX= pnpm exec vitest run`.
4. Run `git -C <tmp> status --short`.

git 2.50.1, Node v24.22.1.

## Expected
Both suites pass, and `git -C <tmp> status --short` prints nothing.

## Actual
adr: `src/cli/accept-copy.test.ts` "adr accept --copy-scope > asks at a terminal: y copies, n
and end of input suggest" fails. The prompt names the decision by its id where the test expects
its number:

```
- Copy the scope of ADR-0001 (docs/it's.md, src/orders/**, src/payments/**) to qk5k19v0? [y/N] …
+ Copy the scope of qdbqwtnj (docs/it's.md, src/orders/**, src/payments/**) to qk5k19v0? [y/N] …
```

The same run had three more failures, all "Test timed out in 5000ms" on a loaded machine
(load average 20 on 8 cores): `src/cli/scope.test.ts` "lets a proposed decision name code that
doesn't exist, and checks it once accepted" and two `src/kind/properties.test.ts` tamper
detection properties. They may be load only.

issues: 18 tests fail in `src/mcp/prompts.test.ts` (4), `read-tools.test.ts` (6),
`resources.test.ts` (4) and `write-tools.test.ts` (4). Issues are not found by number:

```
McpError: MCP error -32602: MCP error -32602: unknown issue 1
```

and `issues_get` answers `{ "error": { "code": "usage", "message": "unknown issue 2" } }` where
the `issues-show/v1` document is expected.

`git -C <tmp> status --short` then lists `AD docs/adr/…` entries after the adr run (for example
`AD docs/adr/decisions/qk5k19v0-use-aurora-for-orders.md`) and 60 `AD docs/issues/…` entries
after the issues run (for example `AD docs/issues/events/3kcd6txk/…-commented.yaml`).

Both suites run in-process and pass `r.env` in (`CliIO.env`, `serveIssuesMcp({ env })`), so some
git call on those paths reads `process.env` instead. The cause is not located yet. It may be a
product bug, not only a test one.

## Done when
- adr's and issues' suites pass with `GIT_DIR` set to another repository, and that repository's
  index is unchanged afterwards.
- The per-commit check run under `git rebase --exec` from a linked worktree passes for a commit
  that changes ledger.
- The pull request that does this closes the issue in the same change, with a reason saying how
  each condition was met.
