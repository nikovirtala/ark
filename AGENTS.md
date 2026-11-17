# AGENTS.md

## Terminology

The unit of work we ship is a **change**: one coherent piece of
behavior or functionality we deliver. A pull request is just the
review-and-merge mechanism a change goes through; it is not the work
itself. A change might go out in one pull request or several, and you
should describe the work in terms of changes.

Say "pull request" only when you mean the actual pull request object,
such as opening one, linking to one, or responding to review comments
on it, and always write it out in full rather than abbreviating it.

## Git history

Linear history is required.

- Before starting work and again before merging, run `git fetch` and rebase your branch onto `origin/main`.
- After rebasing, check every commit builds: `git rebase --exec scripts/check-commit.sh origin/main`. This check does not run tests; they run at the branch tip.
- Merge only via fast-forward or GitHub's "Rebase and merge", so `main` gets the reviewed commits as they are; no merge commits, no squash merges.
- Never force-push `main`. On your own branches, use `git push --force-with-lease`, never `--force`.
- Undo changes on `main` with `git revert`, never by rewriting history.

## Commits

- Each commit is atomic: one logical change, self-contained.
- Each commit passes `scripts/check-commit.sh` on its own: lint always, and, unless only Markdown changed (outside `docs/adr/`, `docs/issues/` and `packages/*/src/`, and not listed in `scripts/test-inputs.txt`), install, a build from an empty `dist/`, `adr verify`, `issues verify` and the index checks. So `git bisect` works at every point in history. Tests run at the branch tip, not at every commit: a commit in the middle of a branch can fail its tests, and `main` can carry such a commit. See "Finding a regression".
- To amend an earlier commit on your branch, use `git commit --fixup=<sha>` rather than piling on "address review" commits.
- Squash fixups before merging: `git rebase -i --autosquash origin/main`. `fixup!` and `squash!` commits must **never** reach `main`.

## Commit messages

Follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

    <type>(<optional scope>): <description>

    [optional body]

    [optional footer(s)]

- Types: `feat`, `fix`, `build`, `chore`, `ci`, `docs`, `perf`, `refactor`, `revert`, `style`, `test`.
- Description: imperative mood, starting with a lowercase letter (the rest keeps its natural casing), no trailing period, ≤72 characters.
- Breaking changes: add `!` after the type/scope and a `BREAKING CHANGE:` footer explaining the impact and migration.
- The body explains *why*, not *what*.

## Pull requests

- Open a **draft** pull request as soon as your branch has its first commit: push the branch and open the PR against `main` right away. Don't wait until the work is finished.
- Push after every new commit (including `fixup!` commits, using `--force-with-lease` when history was rewritten), so the PR always matches your local branch. Pushing doesn't require rebasing or a full per-commit test run; CI covers the tip of each push.
- While the work is in progress, run tests as you normally would: on your working tree or the branch tip. Don't rebase onto `origin/main` or run per-commit checks after each fixup or before each push.
- Keep the PR description up to date as the work changes: what the change does, why, what's still left, and how it was tested.

### Before marking ready for review

Do this once, when the work is complete and you're about to request review, not earlier:

1. Squash all `fixup!`/`squash!` commits (`git rebase -i --autosquash origin/main`).
2. Rebase onto the latest `origin/main`.
3. Verify every commit builds: `git rebase --exec scripts/check-commit.sh origin/main`.
   The script runs lint for every commit. Unless only Markdown changed (outside `docs/adr/`, `docs/issues/` and `packages/*/src/`, and not a file that tests read; `scripts/test-inputs.txt` lists those), it also runs install, a clean build from an empty `dist/`, `adr verify`, `issues verify` and the index checks. It runs no tests, so it takes seconds per commit. On this repository's last 5 commits of `main` it took 27 s (572 s with tests), on the last 17 it took 89 s (2036 s with tests).
4. Run the tests on the branch tip: `pnpm test`, or `scripts/check-commit.sh --tests origin/main` for the tests of the packages the branch changed and their dependents (it also rebuilds from an empty `dist/`). Tests run once, on the final tip.
5. Push with `--force-with-lease` and wait for CI to go green. CI tests the tip of each push.
6. Finalize the PR description.

If step 3 or 4 fails, fix the offending commit (fixup + autosquash), then rerun steps 2–5. Don't repeat the checks for any other reason.

### Marking ready

- Mark the PR **ready for review** (remove draft status) only after all of the above is done and nothing is left to do.
- Use `gh pr ready <number>` or the GraphQL `markPullRequestReadyForReview` mutation. The REST API can't remove draft status. If your environment can't run either, say so explicitly when you hand off, and ask the maintainer to click "Ready for review".
- If review requires more work, move the PR back to draft, make the changes with ordinary pushes, and repeat the "Before marking ready for review" steps once before marking it ready again.

## Finding a regression

When a test fails on a branch tip or on `main`, find the commit that broke it with `git bisect` and the tests:

    cp scripts/bisect-tests.sh /tmp/
    git bisect start <bad> <good>
    git bisect run /tmp/bisect-tests.sh [<package>...]

Always run the copy: commits from before `scripts/bisect-tests.sh` existed don't have it, and `git bisect run` stops on the missing script (exit 127). For each commit, the script installs, builds from an empty `dist/` and runs the tests of the named packages (every package when none is named). Name the failing package to save time. A commit that can't be installed or built is skipped (exit 125), not marked bad. `scripts/check-commit.sh --tests <base>` also works for a branch, but it marks a commit bad for a lint or log failure too, and without `<base>` it tests only the packages the commit itself changed.

## Test file durations

vitest runs one file's tests one after another in one worker. A file that takes longer than its package's summed file time divided by the worker count finishes last, however the other files are scheduled. `pnpm test:durations` runs every package's suite and lists the files that break this rule (`scripts/check-test-durations.mjs` explains the options, and also reads saved vitest JSON reports). Split a file that breaks it along the outermost loop of its test matrix, and give each property test its own file. Shared setup goes in the package's `src/test-support/` (`src/testing/` in ledger).

## Review findings

ark tracks its open work in `docs/issues/` with its own `issues` tool (`node packages/issues/dist/cli.js` after `pnpm build`). Code reviews use it for findings that don't block:

- High and medium findings block the review and are fixed in the pull request.
- Fix a low finding in the pull request only when it's a one-line change to code the pull request already touches. Otherwise the reviewer files it as an issue in the same pull request, with the evidence, scope globs on the affected files, a Done when, and a `relates-to` link to the issue the pull request works on.
- Before filing, look for an existing issue (`issues for <path>`, and `issues search` once it exists). Comment on it instead of filing a duplicate.
- Agents file with `ARK_AGENT` set and `ARK_ON_BEHALF_OF` naming the person they act for.
- List the filed issues in the PR description under "Filed for later".
- Design reviews don't file issues. Their low findings are fixed in the design.

Architecture decisions in this repository are managed by adr: read .claude/skills/adr/SKILL.md before changing architecture, and follow it.

Issues in this repository are tracked with issues: read .claude/skills/issues/SKILL.md before starting, continuing or finishing work, and follow it.
