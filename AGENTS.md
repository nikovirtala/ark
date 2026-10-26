# AGENTS.md

## Git history

Linear history is required.

- Before starting work and again before merging, run `git fetch` and rebase your branch onto `origin/main`.
- After rebasing, verify every commit: `git rebase --exec "<test command>" origin/main`.
- Merge only via fast-forward or GitHub's "Rebase and merge", so `main` gets the reviewed commits as they are; no merge commits, no squash merges.
- Never force-push `main`. On your own branches, use `git push --force-with-lease`, never `--force`.
- Undo changes on `main` with `git revert`, never by rewriting history.

## Commits

- Each commit is atomic: one logical change, self-contained.
- Each commit builds and passes tests on its own, so `git bisect` works at every point in history.
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
3. Verify every commit: `git rebase --exec scripts/check-commit.sh origin/main`.
   The script runs only what each commit's changes can affect: lint only for Markdown outside `docs/adr/` and `packages/*/src/` that no test reads (`scripts/test-inputs.txt` lists the files tests read; changing one runs those tests); install, a clean build and `adr verify` without tests for `docs/adr/`; tests of the changed packages and their dependents; every test for workspace-level files. Every non-docs commit still builds from an empty `dist/`. Even so it costs up to *test suite duration × number of commits*: phase 2b's 33 commits took 29 minutes instead of 63 with the full gate. That's why it runs only at this point. Running it after every fixup or push wastes that time, and any later rebase onto a newer `main` invalidates the result anyway.
4. Push with `--force-with-lease` and wait for CI to go green.
5. Finalize the PR description.

If step 3 fails, fix the offending commit (fixup + autosquash), then rerun steps 2–4. Don't repeat the per-commit check for any other reason.

### Marking ready

- Mark the PR **ready for review** (remove draft status) only after all of the above is done and nothing is left to do.
- Use `gh pr ready <number>` or the GraphQL `markPullRequestReadyForReview` mutation. The REST API can't remove draft status. If your environment can't run either, say so explicitly when you hand off, and ask the maintainer to click "Ready for review".
- If review requires more work, move the PR back to draft, make the changes with ordinary pushes, and repeat the "Before marking ready for review" steps once before marking it ready again.
