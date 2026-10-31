# Test the no-log-at-root note of a cached source in adr and issues

## Goal
Test the "source X has no decision/issue log at <root> in <commit>" note in adr and issues, so the wiring from ledger's `readSourceSubjects` (`empty`, `root`) to the tools' notes is checked by the tool suites.

## Notes
Found in code review v1 of the change for ?41.

- ?41 moved the folding of a cached source into ledger as `readSourceSubjects` (`packages/ledger/src/surfaces/source-read.ts`), which returns `{ subjects, root, empty }`. adr's `readDecisionSources` (`packages/adr/src/sources.ts:67`) and issues' `readIssueSources` (`packages/issues/src/sources.ts:190`) build the note "source X has no decision/issue log at <root> in <commit>" from `found.empty` and `found.root`.
- In adr these lines changed in ?41: `ref.layout.root` and `snapshot.subjects.size === 0` became `found.root` and `found.empty`.
- No `*.test.ts` under `packages/adr/src` or `packages/issues/src` contains "has no decision log at" or "has no issue log at". ledger's `source-read.test.ts` checks `empty: true` and `root: "elsewhere"`, but not the tools' messages, so a wrong field in either tool would go unnoticed.

## Done when
- An adr test and an issues test read a cached source whose root holds no log and assert the "source X has no decision/issue log at <root> in <commit>" note.
