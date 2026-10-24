---
"@nikovirtala/adr": minor
---

adr phase 2b, "Guardrails". With `[log] index = "committed"`, `adr index` writes a generated
`index.md` (accepted and proposed decisions, then inactive ones, with numbers, linked titles,
status and date), every write keeps it fresh, `adr index --check` and `verify` check it, and
`adr index --commit` commits it. Its numbers are projected: on a branch, the numbers its
acceptances will get once it merges. A write notes when the staged `index.md` lists another
decision's files that aren't staged. In a shallow clone, display numbers come from `index.md` in
the commit being read, with a note; nothing is fetched automatically.

`adr hooks install|uninstall|print|run|trailers` installs adr in ledger's shared hook shims:
`pre-commit` runs rename following, the index step and `verify --staged`; `commit-msg` adds the
`ADR:`/`ADR-Event:` trailers; `pre-push` verifies against the upstream (or `origin`'s default
branch, or the whole log); `post-merge` runs the new `adr list --since ORIG_HEAD`, which lists the
decisions with events added since a revision. `hooks print --manager lefthook|husky|pre-commit`
prints the config for a hook manager instead. New config: `[hooks] scope_follow_renames`
(`stage`, `warn`, `off`) and `[hooks] index` (`check`, `stage`).

When git refuses a `--commit` (a hook, signing), adr saves the message to
`<git dir>/ark/COMMIT_MSG` and prints the exact command that finishes the commit, why rerunning
adr won't, and the notes the write would have reported.

verify gains checks over code: `scope/glob-invalid`, `scope/glob-unmatched` for proposed and
accepted decisions, `scope/anchor-missing`, `decision/governed-by-inactive` (a warning, or an
error with `[verify] governed_by_inactive = "error"`) and the `decision/scope-narrowed` warning.

### Changed behaviour

- `[log] index = "committed"` (accepted but unused in 0.2.0) now makes verify require a current
  `index.md`. Run `adr index` and commit it.
- verify can fail on unmatched or invalid scope globs and dangling `adr:` anchors. Fix the globs
  or anchors, or exclude docs that show examples with `[scope] anchor_exclude`.
- Deprecated decisions' globs no longer have to match files (`activeIn` is proposed and
  accepted).
- A refused `--commit` exits 2 with `commit-failed` and the recovery hint instead of
  `git-failed`; the write stays staged. With `--json`, the `ark-error/v1` document also has the
  write's `notes`.
- `adr scope --set <glob>` for a glob that matches no tracked file now notes that verify reports
  `scope/glob-unmatched` until a file matches, so with hooks installed its `--commit` fails in
  pre-commit.
