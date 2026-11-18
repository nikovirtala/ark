# Stop the fold at an unknown event type

## Context
ledger preserves unknown envelope and `data` fields and stops with a finding when it meets an envelope version it does not know (the ark design, docs/00-ark-v1.md; ADR-0003). It says nothing about an event type a kind does not define, inside a known envelope.

With other repositories running ark's tools from `latest` (va08e4c3), sessions on different versions write to the same logs, so an older reader can meet a newer event type, for example after `latest` is rolled back. Skipping such an event can mislead: an event may change state, and a skipped `superseded` leaves a decision looking accepted. Event format changes ship read first, write later (0j5y197e), so a reader meets an unknown type only after an unexpected rollback past the release that taught readers the new type.

## Decision
We will stop folding a subject's log, with a finding, when it holds an event type the reader's kind does not define, as ledger already does for an unknown envelope version. A reader never skips such an event and never guesses its effect.

## Scope
ledger's fold and verify, for every kind built on ledger: adr, issues and any later kind. It does not change how unknown fields are handled; those are still preserved and ignored.

## Consequences
Easier: a tool never shows an agent or a person a state it computed by ignoring an event, and the rule is the same for every kind.

Harder: a version cannot read a subject whose log holds a newer event type until it is upgraded; the finding has to say which type it met and which version introduced it.

Risk: a rollback past a format's read release leaves the affected subjects unreadable until `latest` moves forward again, which the read-first, write-later rule exists to prevent.
