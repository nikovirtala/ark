# Tell the person to rebuild when ark's git hooks run a stale workspace build

## Summary
In ark's own checkout the git hooks run the workspace's built tools (packages/adr/dist, packages/issues/dist, through scripts/git-hooks.mjs), not the published ones. When the checkout has moved ahead of its build, the hook's checks run old code against new files and report the files as wrong. The message sends the person to fix a file that is right instead of telling them to rebuild.

## Steps to reproduce
1. In a checkout of ark, build the workspace at an older main: `pnpm install && pnpm build` (this installs the hooks through `prepare`).
2. Pull a main on which the tool's output has changed since that build (on 23 November 2026, issues' index format had changed since the local build).
3. Make any ledger write that commits, for example `npx -y @nikovirtala/adr@latest accept <id>` on a proposed decision.

The published tool writes the change; the pre-commit hook, running the old workspace build, checks it.

## Expected
The hook notices that the build it is about to run is older than the source it was built from and stops with one line, before any check: the build of issues (or adr, or ledger) is older than its source; run `pnpm build` and commit again. No file is named as wrong.

## Actual
```
adr: error: git commit failed (exit 1): ...
  docs/issues/index.md: error: docs/issues/index.md is not what the tool generates; run issues index and commit it [index/stale]
```
The committed index was correct: published issues 0.7.0 regenerated it with no change. Running `pnpm build` fixed the commit.

## Done when
- The hook shims in ark compare each workspace tool's build with the source it was built from (for example a hash or the newest source mtime recorded at build time, checked against packages/<tool>/src) and stop with the rebuild message when the build is older.
- A test builds a tool, changes a file in its src, runs the hook and asserts the rebuild message and that no ledger check ran.
- With a current build the hooks behave exactly as before; the existing hook tests pass unchanged.
- Only ark's own checkout is affected: repositories that use the published tools through npx see no change.
