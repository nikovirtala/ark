# Garbage-collect unused source caches

## Goal
Remove the source caches that no configured source uses any more, so `<git common dir>/ark/sources/` stops growing.

## Notes
From the Backlog of `docs/00-ark-v1.md`. ledger's `fetchSource` (`packages/ledger/src/sources/fetch.ts`) fetches each `[[sources]]` entry into its own bare cache repository, `<git common dir>/ark/sources/<name>-<key>.git`, where the key hashes the URL and the ref, with a `.lock` file next to it while a fetch runs. Changing a source's URL or ref, or removing the source, leaves the old cache behind, and nothing ever removes it. That only costs disk space.

The cache directory sits under the git common dir, so every worktree of the repository shares it, and another branch may still use a cache that this branch's config no longer names.

## Done when
- ledger removes source caches under `<git common dir>/ark/sources/` that no `[[sources]]` entry uses, and adr and issues expose it as a command next to `sources fetch`.
- The rule for what counts as unused is documented, including how it treats caches that another worktree or branch may still use.
- It never removes a cache whose lock is held, and never touches anything outside `ark/sources/`.
- Tests in `packages/ledger` show that a cache whose ref changed is removed, the current cache is kept, and a locked cache is kept.
- ledger's README no longer lists source cache garbage collection under "Later".
- The PR that does this work closes this issue in the same change, with a reason saying how each of these conditions was met.
