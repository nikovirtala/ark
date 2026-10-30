# Stop calling a source's committed index a shallow clone in adr

## Goal
Make `adr list --source <name>` and `adr search --source <name>` describe numbers read from a cached source's committed `index.md` as coming from that source, not from a shallow clone.

## Notes
Code review finding (LOW) of pull request #61 (?9, ?10 and ?11 of ?31). The approved design left it out of scope for the code review to file.

- `packages/adr/src/log.ts:192` returns `numbers come from ${read.root}/index.md (shallow clone)` for any `reason: "index"`.
- A cached source read with a committed index gets that reason from `indexNumbering` in `packages/adr/src/sources.ts`, so `adr list/search --source <name>` call a read of the source's pinned tree a shallow clone.

## Done when
- `adr list --source <name>` and `adr search --source <name>` on a cached source with a committed `index.md` don't say "shallow clone" (for example "numbers come from platform's committed index.md").
- A test covers it.
