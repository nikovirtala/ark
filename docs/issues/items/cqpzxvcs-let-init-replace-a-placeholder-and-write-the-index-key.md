# Let init replace a placeholder and write the index key

## Problem
Setting up ark's issue log with `issues init --commit` took a hand-amended commit (rough edges 6 and 7 of PR #22).

- **A removed `.gitkeep` stays out of the commit (rough edge 6).** `init --commit` commits only the files it wrote, so a staged removal of the placeholder in the root it sets up is left staged:

  ```
  $ git rm docs/issues/.gitkeep
  $ issues init --commit             # exit 0
  wrote docs/issues/issues.toml
  wrote docs/issues/templates/task.md
  committed 15fbc02
  $ git show --stat --format=%s HEAD
  docs(issues): set up the issue log

   docs/issues/issues.toml       | 13 +++++++++++++
   docs/issues/templates/task.md | 27 +++++++++++++++++++++++++++
   2 files changed, 40 insertions(+)
  $ git status --short
  D  docs/issues/.gitkeep
  ```

  Replacing a placeholder takes a second commit or an amend.
- **The starter `issues.toml` has no `index` key (rough edge 7).** The README documents `index = "none"` and that `"committed"` is refused in 0.1.0, but the file init writes has no `index` key or comment, so nothing in it shows what issues PR 2 will change. ark's `docs/issues/issues.toml` got its `index = "none"` line by hand.

## Proposal
- `init` removes a lone `.gitkeep` in the root it sets up and commits the removal with `--commit`, or keeps it and says so in its notes.
- The starter config writes the `index` key with its default and a comment on the values, as ark's own `docs/issues/issues.toml` does.

## Alternatives
Commit every staged change under the root with `init --commit`. That could sweep in unrelated staged files, so only the placeholder is proposed.

## Done when
- `issues init --commit` in a root that holds only a `.gitkeep` either makes one commit that removes it, or leaves it and prints a note naming it, with a test.
- The starter `issues.toml` has an `index` key with a comment saying which values the release accepts, with a test, and the issues README's config example matches it.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
