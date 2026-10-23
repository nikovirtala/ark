# Qualify ids in other logs with the source name

## Context
A log can reference logs in other repositories: a decision log per repository, an org-wide decision repository, or both, and issues links to decisions with `implements`. Subject ids are only meaningful within one log, so a reference into another log has to say which one ([adr: Repository layout](../../01-adr-v1.md#repository-layout), [ledger: what the core provides](../../00-ark-v1.md#ledger-what-the-core-provides)).

## Decision
A reference into another log uses a qualified id, `<source>:<id>`, such as `platform:k3f9q8a1`. The prefix is the `name` of the `[[sources]]` entry in the referencing tool's config: it is required, matches `^[a-z][a-z0-9-]{0,31}$` and is unique within the file. The entry's `kind` only says what kind of log the source holds and is never part of the id. An unqualified id refers to the local log.

A source's log is read at the entry's `root`, otherwise at the kind's default root; a source with neither is a configuration error ([adr: Repository layout](../../01-adr-v1.md#repository-layout)).

## Scope
Every cross-log reference written or resolved by a ledger-based tool, such as adr's `supersedes`, `superseded.by` and `linked.to`, issues' `implements`, and code anchors that name another log; the sources code in `packages/ledger`.

## Consequences
- Each repository picks short names for its sources, and the same id form works for every kind.
- A prefix is local to one config, so the same log can have different prefixes in different repositories, and renaming a source entry breaks references written with the old name.
- Resolving a qualified id needs the source fetched at its pinned ref.
- In adr 0.1.0, `verify` skips qualified references; cross-log checks come in phase 2.
