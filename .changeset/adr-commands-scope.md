---
"@nikovirtala/adr": minor
---

adr phase 2a, "Commands and Scope". New commands: `init` (config and starter templates, never
overwrites), `reject`, `withdraw`, `deprecate`, `note`, `link` (typed links, also to decisions in
a configured source), `scope` (`--set`, `--add`, `--remove`, `--clear`, and `--follow-renames`,
which updates globs for staged renames and only stages) and `for` (the decisions governing files,
from scope globs and `adr:<id>` code anchors, with `--ref`). `accept --copy-scope` copies the scope
of the decisions it supersedes; without the flag it asks on a terminal and otherwise prints the
`adr scope` command.

`--commit` writes Conventional Commits messages (`docs(adr): propose to <title>`,
`docs(adr): decide to <title>`, `docs(adr): set the scope of ADR-0003`, …) from `[commit] subject`
in `adr.toml`. The description starts with a lowercase letter and the rest keeps its natural
casing. A long title is shortened with `Full title:` in the body, and `-m/--message` replaces the
message; a message that ends in its own trailers gets adr's trailers appended to them.
`[scope] anchor_keyword` and `anchor_exclude` configure code anchors. Agents can set
`ARK_ON_BEHALF_OF=<email>` next to `ARK_AGENT`; without it, every agent write notes that
`on_behalf_of` came from the git identity, and an invalid address exits 2. `--commit` checks for
an author and a committer identity before writing anything.

Fixes for 0.1.0: `new` by an agent tells it to ask a human to accept, `new` warns on stderr about
unfilled sections, and `show` says "no globs recorded" with the `adr scope` command instead of
"Applies to: none".

### Changed behaviour

- `--commit` subjects are now Conventional Commits; the old `Propose decision <id>: <title>` and
  `Accept decision <id>: <title>` subjects are gone. The `ADR:`/`ADR-Event:` trailers are
  unchanged, so `git log --grep "ADR: <id>"` still works. To keep another form, set
  `[commit] subject` in `adr.toml`.
- `adr new --no-edit --commit` (or `--commit` without an editor) with unfilled required sections
  now exits 1 and writes nothing. Pass every required section with `--section`, or drop
  `--commit` and edit the draft. After an editor, a draft that still has unfilled sections stays
  staged and isn't committed.
