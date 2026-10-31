# Share the config keys adr and issues both read in ledger

## Goal
Move the reading and validation of the config keys both tools have into ledger, so `adr.toml` and `issues.toml` accept and refuse the same values with one copy of the rules. The same code also replaces issues' copy of adr's `[log]` rules.

## Notes
Candidate 2 of ?29's comparison.

- `parseAdrConfig` (`packages/adr/src/config.ts:79`) and `parseIssuesConfig` (`packages/issues/src/config.ts:87`) share the `fail`, `table`, `bool` and `oneOf` readers. They also share the validation and messages of `[log] default_template`, `main_branch` and `index`, `[policy] auto_commit`, `[verify] fail_on`, `[scope] anchor_keyword` and `anchor_exclude`, `[hooks] scope_follow_renames` and `index`, and `[commit]` (through ledger's `readCommitTemplate`).
- `adrNumberingKeys` (`packages/issues/src/sources.ts:47`) copies adr's `main_branch` and `index` rules, because issues may import adr only through `@nikovirtala/adr/kind`.
- `isTable` is defined five times: in both tools' `config.ts`, in `issues/src/sources.ts`, and in ledger's `sources/config.ts` and `surfaces/tool-log.ts`. Ledger keeps the one in `sources/config.ts`, and `surfaces/tool-log.ts` imports it.
- The `[log] index` message lists its values in a different order: adr and `adrNumberingKeys` say `log.index must be "committed" or "none"`, issues says `"none" or "committed"`. Tests pin both (`adr/src/config.test.ts:111`, `issues/src/config.test.ts:98-100`, `issues/src/sources.test.ts:73`). Keep the order as a parameter: adr and `adrNumberingKeys` pass `indexValues: ["committed", "none"]`, issues passes `["none", "committed"]`. issues' hand-written `fail_on` check gives the same message as adr's `oneOf`, so it moves to the shared reader as is.
- Proposed API, in `packages/ledger/src/surfaces/tool-log.ts` next to `openToolLog`:
  ```ts
  toolConfigReader(config, file): { table, bool, oneOf, fail }
  parseNumberingKeys(log: Record<string, unknown>, fail, { indexValues }): { mainBranch: string | null; index: "none" | "committed" }
  parseSharedKeys(config, file, {
    tool,                // "adr" or "issues": the file-name fallback `${tool}.toml` in messages
    defaults: { defaultTemplate, anchorKeyword, commit: { vars, names, defaultSubject } },
    indexValues,
  }): SharedKeys         // calls parseNumberingKeys, then the rest
  // SharedKeys: { defaultTemplate, mainBranch, index, autoCommit, failOn, anchorKeyword,
  //   anchorExclude, scopeFollowRenames, hookIndex, commitSubject }
  ```
  Each tool passes its defaults (`nygard` or `task`, its kind's `anchorKeyword`) and, for `[commit]`, the `COMMIT_VARS`, `COMMIT_NAMES` and default subject (`docs(adr)` or `docs(issues)`) it now passes to `readCommitTemplate` (`adr/src/config.ts:167`, `issues/src/config.ts:201`). The fallback replaces `file ?? config.file ?? "adr.toml"` (`adr/src/config.ts:81`, `issues/src/config.ts:89`). Each tool's own keys stay in the tool.
- `adrNumberingKeys` calls only `parseNumberingKeys`, so issues still validates only that `[log]` is a table, `main_branch` and `index` in an `adr.toml`, and never refuses one over keys it doesn't read.
- For a file with several bad keys, the first one reported may change, because the shared parser checks keys in one fixed order (today adr checks `default_template`, `main_branch`, `anchor_keyword`, `anchor_exclude`, then `index` and the rest; issues `default_template`, `main_branch`, `index`, `fail_on`, `anchor_*`, `sources`, then the rest). No test asserts this order, and nothing else changes.
- ?12 also edits `packages/issues/src/sources.ts` (in `indexNumbering`) and `packages/ledger/src/sources/config.ts` (the source-name pattern). Those are different functions, so the two can run in parallel. ?2 changes `packages/ledger/src/sources/**`; rebase onto it if it lands first.
- Placement: everything above imports from `sources/`, `scope/` (`parseGlob` from `scope/glob.ts`, for `anchor_exclude`) and `surfaces/`, all at or below layer 13, which `layers.test.ts` allows for `surfaces/`.
- `[scope] anchor_keyword`: `parseSharedKeys` uses `KEYWORD` from `packages/ledger/src/scope/anchors.ts:21`, exported for it (layer 10 ≤ 13), and defines no copy; the message keeps `KEYWORD.source`, so `scope.anchor_keyword must match ^[a-z][a-z0-9-]{0,31}$` doesn't change. ?12 and G also edit `scope/anchors.ts` (other lines); whichever lands second rebases. This removes the copies at `adr/src/config.ts:67` and `issues/src/config.ts:70`. Ledger's `kind/define.ts:10` (layer 6, below `scope/`) can't import it and keeps its copy; `testing/anchors.ts:4` may import it but this issue doesn't require it.
- Document the new exports in `packages/ledger/README.md`, as fe1f412 did.

## Done when
- ledger exports one config reader, a parser of the `[log]` numbering keys and a parser of the shared keys, with unit tests.
- `parseAdrConfig` and `parseIssuesConfig` use the reader and the shared-keys parser, issues' `adrNumberingKeys` uses only the numbering-keys parser, and no copy of the shared validation or of `isTable` remains in adr or issues.
- adr's and issues' existing config tests pass with no change to the messages they expect.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
