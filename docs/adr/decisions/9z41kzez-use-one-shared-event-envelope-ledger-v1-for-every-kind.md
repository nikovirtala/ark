# Use one shared event envelope, ledger/v1, for every kind

## Context
One goal of ark is one event envelope across tools, so any tool can fold any other tool's log with the same engine ([Summary](../../00-ark-v1.md#summary)). The envelope and each kind's `data` schema need to evolve independently, and a newer tool must be able to add fields without breaking older readers ([ledger: the shared event envelope](../../00-ark-v1.md#ledger-the-shared-event-envelope)).

## Decision
Every event of every kind is one YAML file in the `ledger/v1` envelope, versioned separately from the kinds' data schemas. Its fields are `envelope`, `kind`, `schema` (`<kind>/v<n>`), `id` (a ULID), `subject`, `type`, `at` (UTC), `actor` (`kind` human or agent, `name`, `email`, `agent`, `on_behalf_of`), an optional `reason`, and `data`.

Everything a kind defines goes in `data`, validated against the kind's JSON Schema; the envelope fields mean the same for every kind. Unknown envelope fields and unknown `data` fields are preserved and ignored. A reader that meets an envelope version it doesn't know stops with a finding rather than guessing ([ledger: the shared event envelope](../../00-ark-v1.md#ledger-the-shared-event-envelope), [adr: Event schema](../../01-adr-v1.md#event-schema)).

## Scope
Every event file that a ledger-based tool writes or reads, in its own log and in logs read through `[[sources]]`; the envelope code in `packages/ledger`.

## Consequences
- One engine orders, attributes and validates any log. issues can fold the decision log by importing `adrKind` from `@nikovirtala/adr/kind`, without shelling out to a CLI.
- Tools can add fields without breaking older readers.
- Changing the envelope itself means a new envelope version, which older readers refuse with a finding (`envelope/unknown-version`), so it needs a coordinated release.
- A kind can't add its own top-level fields. `reason` stays optional in the envelope; a kind makes it required per event type.
