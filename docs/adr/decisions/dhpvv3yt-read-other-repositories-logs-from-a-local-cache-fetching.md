# Read other repositories' logs from a local cache, fetching only when asked

## Context
adr and issues reference logs in other repositories through [[sources]] (platform:k3f9q8a1), and verify has to check those references. Fetching every source on every verify would make the pre-commit hook and plain reads depend on the network and on credentials, and slow them down; never fetching would leave CI checking whatever happened to be cached. ark's issues decision 2 (option B) chose cache-only by default with an explicit fetch for CI and pre-push, a failed fetch as an error, a sources fetch command, any ref kind and the resolved commit in --json (00-ark-v1 'Sources', 01-adr-v1 and 02-issues-v1).

## Decision
References into other repositories' logs are resolved against a local cache of each [[sources]] entry that ledger keeps inside the repository's git directory: one cache per source name, URL and ref, locked while it is fetched. Plain verify, the pre-commit hook and every read and write use only the cache and never the network; a referenced source that isn't cached gives one sources/not-fetched warning and its references aren't checked. verify --fetch-sources, which CI and the pre-push hook run, fetches each source's ref first, and a failed fetch exits 2 under ADR-0004, because the checks couldn't run. <tool> sources fetch refreshes the cache by hand. A ref may be a branch, tag or full commit; verify --json records the commit each source resolved to, and tags or commits are recommended for reproducible CI. Credentials are plain git's.

## Scope
ledger's Sources layer (packages/ledger/src/sources, verify --fetch-sources, sources fetch), adr's and issues' reading of [[sources]], and their pre-push hooks.

## Consequences
- Local commands work offline and never prompt for credentials; a stale cache can hide a broken reference until CI or pre-push fetches.
- With a configured source, pushing offline exits 2 in the pre-push hook; git push --no-verify skips it, and CI stays the guard.
- A branch ref moves, so CI results can change without a local change; a tag or a full commit keeps them reproducible.
- Private sources in CI need git credentials (an insteadOf URL with a token from the CI secret store, or an SSH deploy key).
