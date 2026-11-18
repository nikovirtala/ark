# Ship event format changes read first, write later

## Context
Rolling back a release by moving `latest` (va08e4c3) reverts the tool, not the events it already wrote into the append-only logs of the repositories that ran it. Users need backward compatibility (a new version reads old events), and ledger already gives it for added fields, which are preserved and ignored. Rollback needs the other direction too: the previous version must read what the rolled-back one wrote.

Amazon solves the same problem for stored formats with a two-phase deployment: one release learns to read the new format while still writing the old one, a later release starts writing it, with days between the two (Builders' Library, "Ensuring rollback safety during deployments"). The factory design (docs/04-factory-v1.md) adopts it for ark.

## Decision
We will ship every event format change beyond an added field in two releases.

- **Read first.** Release N+1 learns to read the new form (a new event type, a new `schema` version, a changed meaning) and still writes the old one.
- **Write later.** Release N+2 starts writing it, no sooner than 7 days after N+1 reached `latest` (a value kept in the factory configuration).
- **Prove it on promotion.** Promotion runs both versions against one scratch log: the previous `latest` and the new version writing side by side, then the new version alone, then the previous version alone again. Every stage must fold and `verify` clean.
- **A person decides.** Changes to a kind's event schema or to ledger's envelope are frame paths that Niko reviews; the reviewer checks the two-release rule against the schema diff.

## Scope
The event schemas of every kind (adr, issues and later kinds) and ledger's envelope, and the compatibility check in the factory's promotion. Added fields stay a single-release change.

## Consequences
Easier: rolling back one release never strands a log, so automatic rollback is safe for event-writing tools.

Harder: a format change takes two releases and at least a week; reading code for a new form ships before anything writes it.

Risk: a change wrongly judged to be only an added field skips the rule; the schema-diff check and the frame path exist to catch it.
