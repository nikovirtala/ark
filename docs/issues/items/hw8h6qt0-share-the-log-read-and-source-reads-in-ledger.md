# Share the log read and source reads in ledger

## Goal
Move into ledger the parts of reading a log that adr and issues implement the same way: the check pipeline, numbering with the committed-index fallback, `changedSince`, the `--source` read and the folding of a cached source. Each tool then keeps only its options, notes and documents.

## Notes
Candidate 4 of ?29's comparison.

- The check pipeline (`loadFindings`, `transitions`, `invariantsCheck`, `relateCheck` over one `CheckContext`, then `sortFindings` with the kind's name) appears in `readDecisionsFrom` (`packages/adr/src/log.ts:119`) and `readIssuesFrom` (`packages/issues/src/log.ts:153`).
- `numberLog` with the committed-index fallback appears three times: `numberDecisions` (`adr/src/log.ts:98`), `numberIssues` (`issues/src/log.ts:132`) and `readDecisionLog` (`issues/src/sources.ts:79`).
- These are word for word: `ChangedSince` and `changedSince` (`adr/src/log.ts:242, 260`; `issues/src/log.ts:445, 462`), `unavailableReason` (`adr/src/log.ts:207`; `issues/src/log.ts:282`), `NumberingJson` and `numberingJson` (`adr/src/views.ts:13, 56`; `issues/src/views.ts:13, 121`), and the fold-order `events` of `showDecision` and `showIssue`.
- The `--source` read: `readSourceDecisions` (`adr/src/sources.ts:115`) and `readSourceIssues` (`issues/src/log.ts:225`). Once a config is found, both read an uncached source as an empty `MemoryTree` with a "not fetched" note, and a cached one through `sourceLogRef` with index numbering. Before that they differ: adr checks the source's kind before looking up its name (`adr/src/sources.ts:121-124`, `source X has kind Y, which adr doesn't read`) and its unknown-source message also lists skipped sources; issues looks up the name first, then checks the kind (`issues/src/log.ts:230-241`, `source X is a decision log; --source reads issue logs`). So the pattern check, the name lookup, the kind check and their messages stay in each tool, and only the part after a config is found moves.
- Folding a cached source into status, display and title: `readDecisionSources` (`adr/src/sources.ts:67`) and `foreignSubjects` (`issues/src/sources.ts:186`).
- Domain stays in the tools: issues reading the local decision log and every cached source on each read (for `implements` and foreign blockers), each tool's notes, and its resolve messages.
- ?35 and ?36 change `readSource…` and adr's `numberingNote`. After them both tools behave the same, which is why this lift waits for them.
- Proposed API and placement:
  - In `packages/ledger/src/surfaces/`: `readKindLog(kind, tree, { layout, numbering, checkOptions, projectOptions? })`, where `checkOptions` goes to `invariantsCheck` and `relateCheck` and `projectOptions` to `projectLog` (issues passes its full `IssueOptions` as `checkOptions`, and `{ sources }` as `projectOptions` only when `sources !== null`, as `issues/src/log.ts:184-206` does; adr passes no `projectOptions`); `numberToolLog(git, { kind, layout, mainRef, index, ref })`, `changedSince`, `unavailableReason`, `numberingJson` and `eventsInFoldOrder`.
  - In a new `packages/ledger/src/surfaces/source-read.ts`:
    ```ts
    readSourceLog(git, config: SourceConfig, { kind, notFetched: string }):
      Promise<{ tree: TreeReader; layout: LogLayout; numbering: Numbering; commit: string | null; notes: string[] }>
    readSourceSubjects(fetched, kind, toForeign)
    ```
    For an uncached source, `readSourceLog` gives an empty `MemoryTree`, the layout at `config.root ?? kind.def.defaultRoot`, the numbering both tools give an unfetched source once ?35 lands (today `NO_NUMBERING`, whose `no-main-ref` reason is what ?35 fixes; don't copy that value), a `null` commit and `[notFetched]` (for example `"<name> not fetched; run adr sources fetch"`). For a cached one it gives `sourceLogRef`'s tree and layout, the numbering of its committed index from ?12's `indexNumbering` as ?36 leaves it, its commit and no notes; the tool adds its own notes. `readSourceSubjects` folds and numbers a cached source into a `ForeignSubject` map. Both call `readIndexNumbers` and ?12's `indexNumbering`, which live in `log-index/` (layer 11), so they can't go in `sources/` (layer 9).
  - In `packages/ledger/src/sources/`: only the type `ForeignSubject<S extends string = string>` (`{ status: S; display; title; effective: string | null }`). adr's exported `ForeignDecision` and `AdrSource` and issues' `SourceLog` stay as they are: a `ForeignSubject<DecisionStatus>` is assignable to `ForeignDecision`, so no public type of `@nikovirtala/adr/kind` changes.
- ?12 overlaps ?35 and ?36 in the same functions; this lift waits for all three, so it moves whatever they leave.
- The qualified-reference lift edits other functions of `adr/src/sources.ts`, `issues/src/sources.ts` and `issues/src/log.ts`; whichever lands second rebases.
- ?2 changes `packages/ledger/src/sources`. Rebase onto it if it lands first.
- Document the new exports in `packages/ledger/README.md`.

## Done when
- ledger exports the read pipeline, the numbering with its fallback, `changedSince`, `unavailableReason`, the `--source` read and the cached-source folding, with unit tests.
- adr and issues use them, and none of the copies listed in the Notes remains in either tool.
- `list`, `show`, `search` and `for`, with and without `--source`, print the same text and `--json` documents as before: both tools' existing tests pass with no change to what they assert.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
