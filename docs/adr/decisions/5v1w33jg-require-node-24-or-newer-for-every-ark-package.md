# Require Node 24 or newer for every ark package

## Context
ark is built and tested on one Node version: `mise.toml` pins Node 24, and the CI and release workflows set it up. The packages declare `engines: { node: ">=24" }`, so `npx` on older Node prints npm's `EBADENGINE` warning. Supporting older Node would need a version matrix in CI and code that avoids newer Node APIs, and ADR-0001 keeps one toolchain for all packages ([Monorepo](../../00-ark-v1.md#monorepo)).

## Decision
Node 24 is the minimum supported runtime for every ark package. The workspace root and every package declare `engines: { node: ">=24" }`, the bundles target `node24`, and `mise.toml`, CI and the release workflow use Node 24 with no version matrix. The ledger and adr READMEs state the requirement.

## Scope
The supported runtime of every ark package: the `engines` fields, the bundle targets, the toolchain in `mise.toml`, and the Node version in the CI and release workflows.

## Consequences
- Code can use any Node 24 API, and CI runs on one Node version.
- Users on older Node get npm's `EBADENGINE` warning and are not supported.
- Raising the minimum later is a new decision that supersedes this one, released as a breaking change.
