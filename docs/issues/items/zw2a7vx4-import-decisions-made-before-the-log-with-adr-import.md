# Import decisions made before the log with adr import

## Problem
A decision made before a repository had a decision log can be mentioned, but not superseded, so the chain of what is in force starts with a gap. Kiro asked for a `supersedes-external <url>` link, which the fold can't use: an outside document never says it was superseded.

## Proposal
Implement the second half of adr:27h9h6y7: `adr import <file>` writes a decision and its accept in one commit, with `decided_on` and a link to the source, so it can be superseded like any other.

## Done when
- `adr import <file> --decided-on <date> [--source <url>]` writes the decision with the file as its body, accepted, in one commit, and prints its number.
- An imported decision can be superseded with `--supersedes` as usual.
- `adr new --supersedes` given a path or a URL instead of a decision is refused with a message pointing to `adr import`.
- The README has a short section on bringing in decisions made before the log, with an example.
- `adr import --help` says what the command writes and that the body freezes on import, as on any accept.
