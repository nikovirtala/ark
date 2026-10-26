# Display issue numbers with a ? prefix

## Context
Forges link `#42` to their own issues and pull requests in commit messages and markdown, so an issue number written that way points at the wrong thing. Issue numbers are derived from main's first-parent history, so an issue opened on a branch has none until the branch merges, and the canonical id is what stays the same.

## Decision
Issues are numbered in the order their `opened` events land on main's first-parent history. They are displayed as `?42`, never `#42`, so forges don't link the number to their own issues and pull requests in commit messages and markdown. Numbers are derived, never stored. Files, events, links and commit trailers use the canonical id. Every command and tool accepts any of the three forms: the id, the bare number, or the `?` number. Trailers and links always carry the canonical id. In a shell, the bare number avoids `?` being read as a glob.

## Scope
How issue numbers are shown and parsed by issues.

## Consequences
`?` is a shell glob, so an unquoted `?42` can match a file such as `a42`; the docs say to type `42` or quote `'?42'`. The prefix isn't configurable, so every repository shows issue numbers the same way, and an argument that names no issue is reported with what the shell passed.
