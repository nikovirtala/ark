# Keep generated indexes committed and fresh in every commit

## Context
A decision log's status is computed from its events, so raw files on a forge don't show it, and display numbers need main's first-parent history, which shallow clones lack (01-adr-v1 'Display numbers', 'Generated index'). An index rendered on main from main's numbers would go stale whenever an acceptance merges.

## Decision
With [log] index = "committed", every write of a ledger-based tool renders <root>/index.md from the projection of the tree it writes or commits; a --commit includes the file whenever the commit changes it, and the work-tree copy keeps other uncommitted changes' entries. Numbers in the index are projected: the first-parent history of the commit plus, last, the acceptances not yet in it, which is what main will assign after a fast-forward or rebase merge. The file ends with a ledger-index/v1 numbers line. verify checks freshness (index/stale, index/missing) in hooks and CI. In a shallow clone, tools read display numbers from that line; nothing is fetched automatically.

## Scope
The Index layer in ledger (packages/ledger/src/log-index, projectNumbering and the numberLog fallback), adr's index command and write path, and ark's own docs/adr/index.md and docs/adr/adr.toml.

## Consequences
- People browsing a forge see current status and numbers, and shallow clones and CI checkouts get numbers without history.
- Every write touches index.md, so parallel branches conflict on it; rerun adr index during the rebase.
- A merge commit or squash that reorders acceptances, or a branch that isn't up to date, shows up as index/stale on CI, fixed with adr index.
- In a shallow clone, verify trusts the recorded numbers and checks the rest.
