# Build ledger as the shared core for event-sourced records

## Context
adr and issues are the same machine underneath: subjects stored as files, an append-only event log per subject, state folded from events on read, and CI checks that keep the log valid. As two codebases, that machinery would be written twice and the tools couldn't read each other's logs, while issues already needs to know whether an ADR is accepted ([Summary](../../00-ark-v1.md#summary)).

## Decision
We build that machinery once as ledger, a core library for git-backed, event-sourced records. It knows subjects, events, kinds, logs and findings, and nothing about decisions or issues: a tool hands ledger its kind and owns only what its events mean ([ledger: the model](../../00-ark-v1.md#ledger-the-model), [ledger: what the core provides](../../00-ark-v1.md#ledger-what-the-core-provides)).

ledger is published to npm as `@nikovirtala/ledger` at 0.x and documented as internal until its API settles ([Monorepo](../../00-ark-v1.md#monorepo), [Open questions](../../00-ark-v1.md#open-questions)).

ledger grows from its users. Mechanical layers go into the core immediately; layers that encode domain behavior move in only once both adr and issues have used them and the shapes match. Roadmap step 3 is the stated exception: the fold engine, the state machine as data, and the Scope, Index and Surfaces layers are written in ledger with adr as their only user. Relations and set events start in the tools and are lifted in step 5 ([Implementation notes and roadmap](../../00-ark-v1.md#implementation-notes-and-roadmap)).

## Scope
`packages/ledger` and the boundary between it and every ledger-based tool, currently adr and issues. artifact is not built on ledger. Third-party kinds are out of scope: ledger's API is for tools in this repository ([Summary](../../00-ark-v1.md#summary), Non-goals).

## Consequences
- Every ledger-based tool gets one implementation of storage, ids, the envelope, folding, verification, sources, templates and hooks, and a tool can fold another tool's log by importing its kind.
- ledger is installed once when a project uses adr and issues together.
- ledger's 0.x API can change between minor versions, and every change ripples into adr and issues.
- Until step 5, adr and issues each carry their own relation code.
