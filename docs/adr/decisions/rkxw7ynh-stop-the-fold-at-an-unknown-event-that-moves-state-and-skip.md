# Stop the fold at an unknown event that moves state, and skip one that only annotates

## Context
ledger preserves unknown envelope and `data` fields and stops with a finding at an envelope version it does not know (docs/00-ark-v1.md; ADR-0003). It says nothing about an event type a kind does not define, inside a known envelope.

With other repositories running ark's tools from `latest` (va08e4c3), readers on different versions meet the same logs, so an older reader can meet a newer event type, for example after `latest` is rolled back. Event format changes ship read first, write later (0j5y197e), so this happens only after an unexpected rollback past the release that taught readers the new type.

Not every event is alike. A skipped `superseded` leaves a decision looking accepted, so skipping an event that moves state misleads. A note, or the mark of where an agent's turn began, changes no state; stopping on one makes a subject unreadable for nothing. draft already keeps and skips unknown annotations in its own log (draft ADR jj76pjg2, "Treat the context log as a durable execution record"), and kiro-remote's change feed marks each event with `effect: state | annotation` for the same reason (ark ADR 9t6n5jc6).

This replaces the proposal 4djbfgzc, which stopped at every unknown type.

## Decision
An event says what it does. ledger's envelope gains an optional field, `effect`, with the values `state` (the event moves a subject's state) and `annotation` (it only records something about it). Each kind declares the effect of every type it defines, and the writer sets the field from that declaration.

A reader that meets an event type its kind does not define:

- **stops folding that subject, with a finding,** when the event's effect is `state` or the field is missing: an event with no mark is treated as moving state;
- **keeps and skips it** when its effect is `annotation`, and says so in `verify` as a notice, not an error.

A reader never guesses an unknown event's effect from its name or its data.

## Scope
ledger's envelope, fold and verify, for every kind built on ledger: adr, issues and any later kind, and every reader of a ledger log (ark's tools, draft's map). Unknown fields are still preserved and ignored.

## Consequences
Easier: one rule for ark, draft and kiro-remote's feed; an annotation added in a newer release no longer locks older readers out of a subject.

Harder: every kind has to declare the effect of each of its types, and a test has to fail when a type has no declaration. Adding `effect` to the envelope is an added field, which is already safe both ways: an older reader ignores it and folds as it does today. A new type marked `annotation` is still a new event type and ships read first, write later (0j5y197e).

Risk: a type declared `annotation` that does change state would be skipped silently by old readers. A type's effect is fixed when it is introduced and never changed; a type whose meaning grows gets a new type.
