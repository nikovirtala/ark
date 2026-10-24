---
"@nikovirtala/ledger": minor
---

Add the Index layer: generated, committed Markdown indexes (`renderIndex`, `escapeMarkdown`,
`INDEX_FORMAT`), their numbers line (`parseIndexNumbers`, `readIndexNumbers`), the freshness check
(`indexCheck`: `index/missing`, `index/stale`, `index/unchecked`) and `writeIndexFile`. Add
`projectNumbering`, which numbers a tree as its commit will be numbered on main (main's numbers
first, also on a branch that merged main), with `compareNumberingKeys`, a `not` option for
`firstParentAdditions`, and a `fallback` for `numberLog` in shallow clones (`reason: "index"`).

Add checks over code for kinds with `scope`: `scopeGlobCheck`, `anchorCheck`, and the
`governedChanges` and `narrowedScopes` helpers, reading the repository through the new
`CheckContext.repo` (`RepoContext`), which `verifyLog` sets. Add `Git.trackedPaths`,
`Git.changedPaths` and an `ifExists` option for `Git.appendTrailers`; `commitWithRecovery`,
`saveCommitRecovery` and `CommitFailedError` (`commit-failed`), which save a failed commit's
message and give the command that finishes it, with notes that `runCli` prints as warnings and
puts in `ark-error/v1`; `assertNoHookConflicts` and `HookConflictError` (`hook-conflict`);
`resolveVerifyBase` in the `cli` entry; and `danglingAnchor` in the `testing` entry.

### Changed behaviour

- `DEFAULT_HOOK_COMMANDS` includes `pre-push: verify --base @{upstream} --ref HEAD`, so
  `installHooks(git, { tool })` without `commands` also writes a `pre-push` shim. Pass `commands`
  to keep the previous set.
- `verifyCommand` with an upstream base (`@{upstream}`, `@{u}`) that doesn't resolve now verifies
  against `origin`'s default branch, or the whole log without one, with a note, instead of
  exiting 2.
- `Git.appendTrailers` always adds missing trailers at the end, whatever the user's
  `trailer.ifmissing` and `trailer.where` config.
- `HookInstallResult.conflicts` entries have an `argv` field: the tool's command for that hook.
