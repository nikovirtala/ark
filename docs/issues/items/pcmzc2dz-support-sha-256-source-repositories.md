# Support SHA-256 source repositories

## Problem
A `[[sources]]` entry can't point at a repository that uses git's SHA-256 object format. ledger creates every source cache with `git init --bare`, which uses SHA-1, so fetching a SHA-256 repository into it fails in git and surfaces as a `SourceFetchError`. References into such a log can never be checked, and the log can't be listed. From the Backlog of `docs/00-ark-v1.md`, where this is recorded as a known limitation.

## Proposal
Create each source's cache with the object format of the repository it fetches, so a SHA-256 source fetches, pins and reads like a SHA-1 one. A cache whose format doesn't match its source is recreated. Pinning by commit already accepts a 64-character sha (`FULL_SHA` in `packages/ledger/src/sources/fetch.ts`).

## Alternatives


## Done when
- A test in `packages/ledger` fetches a local SHA-256 repository as a source, pins its commit and reads its log, and a 64-character `ref` is served from the pinned cache without a new fetch, as a 40-character one is.
- SHA-1 sources behave as before, and their existing caches are reused.
- ledger's README no longer lists SHA-256 source repositories under "Later".
- The PR that does this work closes this issue in the same change, with a reason saying how each of these conditions was met.
