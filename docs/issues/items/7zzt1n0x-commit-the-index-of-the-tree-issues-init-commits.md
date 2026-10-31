# Commit the index of the tree issues init commits

## Summary
With `[log] index = "committed"`, a committing `issues init` that writes a missing `index.md` renders it from the work tree, so it can commit an index listing issues the commit doesn't contain. That index is `index/stale` at the commit, which ADR-0010 exists to prevent.

## Steps to reproduce
From reading the code at 1ac4c4f; not run.
1. In a repository with an issue log and `[log] index = "committed"`, have an issue whose files are in the work tree but not committed, and no `index.md`.
2. Run `issues init --commit`.
3. Run `issues verify` at the new commit, or `git show HEAD:docs/issues/index.md`.

## Expected
As `adr init` does (`packages/adr/src/init.ts:225, 289-306`): the committed `index.md` lists only what HEAD's tree plus init's files hold, and the work tree's copy is refreshed after the commit.

## Actual
`packages/issues/src/init.ts:172-191` renders `log.tree` (the work tree) even when init commits, the commit takes only init's files (`only: [...staged, ...tracked]`, lines 312-316), and nothing refreshes the index afterwards. The committed index lists the uncommitted issue.

## Done when
- A committing `issues init` with uncommitted issues in the work tree commits an index of HEAD's tree plus init's files, then refreshes the work tree's copy, as `adr init` does.
- A test in `packages/issues/src/init.test.ts` covers it.
- A patch changeset for `@nikovirtala/issues` says that a committing `issues init` now commits the index of the tree it commits.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
