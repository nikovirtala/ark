# Run ledger's Git.open test with the temp repo's environment

## Summary
One test in packages/ledger/src/git/git.test.ts calls Git.open without the temp repo's hermetic environment. It fails whenever GIT_DIR is set, which happens when scripts/check-commit.sh runs under git rebase --exec in a linked worktree.

## Steps to reproduce
1. At dc969ea, run pnpm build.
2. In packages/ledger, run: GIT_DIR=<any other repository's .git> pnpm exec vitest run src/git/git.test.ts
3. Or, from a linked worktree of ark, run git rebase --exec scripts/check-commit.sh origin/main over a commit that changes ledger.

## Expected
The test passes whatever GIT_DIR the caller's shell has, like the other tests that use the temp repo's env.

## Actual
Git.open > opens a work tree with absolute root, gitDir and commonDir fails: expected gitDir to be <temp>/repo/.git, received the outer repository's git dir (/projects/sandbox/ark/.git/worktrees/wt in a worktree). The other 86 tests in the file pass. Line 58 is Git.open(join(r.root)) with no env; GIT_DIR is in GIT_LOCATING_ENV, which only r.env and GIT_ENV_ISOLATION clear. Found while rebasing PR 39 in a worktree; agent workflows work around it with plain clones.

## Done when
- The test passes with GIT_DIR set to another repository, and in the per-commit check run from a linked worktree.
- Any other test in the file that opens a temp repo without its env is checked the same way.
- The PR that does this closes the issue in the same change, with a reason saying how each condition was met.
