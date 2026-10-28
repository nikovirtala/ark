---
"@nikovirtala/ledger": patch
---

`Git.commit` with `mergeTrailers` now asks the installed git whether the message's last paragraph holds trailers (`git interpret-trailers --parse --no-divider`, one call, made only when there are trailers to merge). It no longer follows ledger's copy of git's rules, which git 2.56 changed: git 2.56 doesn't read a line starting with a URL (`https://…`) as a trailer, so on git 2.56 ledger merged its trailers into a paragraph that git then read as having no trailers at all. `Git.commitMessage(o)` returns the exact text `Git.commit` sends, and `commitWithRecovery` saves that text. 0.7.0 was never published (its release failed on git 2.56), so 0.7.1 is the first release with 0.7.0's changes.

Changed behaviour:

- The user's `trailer.separators`, `trailer.<key>.key` and `core.commentChar` config now count when deciding, as they do when git reads the commit.
- A last paragraph whose only trailer-like lines are `(cherry picked from commit …)` lines gets the trailers in their own paragraph. git reads the same trailers as before.
- `commitMessageText(message, trailers, { merge })` only formats: `merge` appends to the last paragraph. Its `mergeTrailers` option is gone.
- When git can't run `interpret-trailers`, the write fails with that `GitError` before anything is committed.
