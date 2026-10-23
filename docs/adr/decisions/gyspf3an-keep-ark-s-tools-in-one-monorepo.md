# Keep ark's tools in one monorepo

## Context
ark's tools (adr, issues and later artifact) share a core library, ledger, and one set of surface conventions. Built in separate repositories, the shared machinery would be written twice and drift apart ([Summary](../../00-ark-v1.md#summary)). Each tool must still ship as its own npm package with its own CLI, installable alone ([Summary](../../00-ark-v1.md#summary), Goals), and a change in ledger has to reach adr and issues without publishing first ([Monorepo](../../00-ark-v1.md#monorepo)).

## Decision
We keep ark's tools in one repository, `nikovirtala/ark`, with one package per tool under `packages/`, linked with pnpm workspaces; ledger is an internal dependency ([Packages](../../00-ark-v1.md#packages), [Monorepo](../../00-ark-v1.md#monorepo)).

Each package is versioned independently: a change records the packages it affects with Changesets, and a release bumps only those, writes their changelogs and publishes them to npm with provenance from GitHub Actions ([Monorepo](../../00-ark-v1.md#monorepo), [RELEASING.md](../../../RELEASING.md)). Lockstep versions were rejected because they publish new versions of unchanged packages ([Open questions](../../00-ark-v1.md#open-questions)).

## Scope
The layout, build and release of the ark repository: the workspace root, `packages/ledger`, `packages/adr`, `packages/issues` and, once it moves in (roadmap step 7), `packages/artifact`; `.changeset/`; the CI and release workflows. It also covers where ark keeps its own records: `docs/adr/` and `docs/issues/`.

## Consequences
- A change to ledger is visible to adr and issues locally, and all packages share one toolchain: TypeScript project references, Vitest with fast-check, and Biome.
- CI tests only the packages a change affects and their dependents, and a release publishes only the packages that changed.
- Every releasable change needs a changeset. Private packages, currently `@nikovirtala/issues`, are never versioned or published.
- artifact keeps living in its own repository until roadmap step 7 ([Implementation notes and roadmap](../../00-ark-v1.md#implementation-notes-and-roadmap)).
