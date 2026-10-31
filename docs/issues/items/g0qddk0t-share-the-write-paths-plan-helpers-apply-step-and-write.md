# Share the write path's plan helpers, apply step and write driver in ledger

## Goal
Move the write path that adr and issues both implement into ledger: the plan helpers, `applyPlan` and the write driver with its retry and editor step. A tool then keeps only its commands' plans, its commit scope and its commit messages.

## Notes
Candidate 5 of ?29's comparison. This is the largest lift.

- Plan helpers: `checkText`, `checkReason`, `viewOf`, `refusal`, `findingKey`, `precheck`, `newEvent`, `filesOf`, `pairsOf`, `chooseTemplate`, `unmatchedGlobs` and the loop of `planFollowRenames`. They are at `packages/adr/src/write.ts:249, 257, 266, 276, 349, 355, 297, 373, 382, 389, 1245, 1439` and `packages/issues/src/plan.ts:190, 199, 217, 225, 238, 245, 271, 304, 310, 497, 1013, 1288`.
- Apply: `applyPlan`, `stagedEventRefs`, `unstagedIndexNote` and `WRITE_RERUN` (`adr/src/write.ts:1558, 1832, 1537, 1528`; `issues/src/apply.ts:169, 438, 141, 86`). They are the same step for step, ?5's port included.
- Driver: `write`, `viewsAfter`, `checkCommitIdentity`, the work-tree check, the plan context, `editorStep` and `readIfPresent` (`adr/src/write.ts:1971, 1870, 1888, 1980, 1994, 2101, 2085`; `issues/src/write.ts:234, 204, 109, 115, 218, 335, 321`).
- Keep these differences as parameters, so neither tool's behavior changes:
  - The commit scope. adr's comes from the plan's involved subjects. issues' `commitScopeOf` widens it while applying, to reached issues not yet in `HEAD`.
  - The index re-render after the editor step. adr renders again only when the staged events changed. issues always does, because an edited heading changes the title.
  - The bytes of the commit tree after the editor step. issues builds `compose`'s tree and the step-4 tree from the work-tree bytes (`commitTree(extra, true)`, `issues/src/apply.ts:226-236, 337, 356`); adr builds both from the plan's bytes first, falling back to the work tree (`plan.files[p] ?? plan.replace?.[p]?.bytes ?? work.read(p)`, `adr/src/write.ts:1626-1636, 1729, 1746`). `afterEditBytes` keeps this: adr passes `"plan"`, issues `"worktree"`.
  - The precheck. adr refuses any finding the write adds. issues refuses added errors, reports added warnings, and `unlink` turns errors into notes. Ledger's `precheck` returns the added findings, and the tool decides.
  - The trailer keys, the tool name in the hints and notes, and the document format.
- Proposed API: a generic `WritePlan` with the shared fields, which each tool extends with its views. `newEvent`, `eventFiles`, `precheck`, `chooseTemplate`, `checkText` and `checkReason`. `applyPlan(log, plan, { trailerKeys, tool, noun, scope?, rerenderAfterEdit: "always" | "when-events-change", afterEditBytes: "plan" | "worktree", compose, message, afterStage, index })`, where `compose` may return a promise, `afterStage` gets the scope, and `afterEditBytes` decides the bytes of both `compose`'s tree and the step-4 tree (adr: `"when-events-change"`, `"plan"`; issues: `"always"`, `"worktree"`). A `runWrite` driver, and `editorStep`.
- Placement: all of it in `packages/ledger/src/surfaces/` (new `write-plan.ts`, `apply-plan.ts` and `write-driver.ts`), because `applyPlan` commits through `commitWithRecovery` and calls C's hints in `surfaces/tool-index.ts`. `stagedEventRefs(layout, paths)` (15 lines, `adr/src/write.ts:1832`, `issues/src/apply.ts:438`) goes in `surfaces/commit-message.ts`, next to the `EventRef` type it returns. The init-and-hooks lift builds its `commit-msg` trailers on it too and doesn't wait for this issue: whichever of the two lands first moves `stagedEventRefs`, and the other uses it.
- Risk: high. The net must pass unchanged: in adr, `src/write.model.test.ts`, `src/write.test.ts`, `src/write.copy-scope-operation.test.ts`, `src/cli/write.test.ts` and `src/cli/index-invariant.*.test.ts`; in issues, `src/plan.model.test.ts`, `src/plan.test.ts`, `src/write.test.ts`, `src/write.index.*.test.ts`, `src/cli/commit-staged.test.ts` and `src/cli/index-invariant.test.ts`. Keep `applyPlan` and the driver in separate commits, and switch each tool over one part at a time (about 6–8 commits).
- The qualified-reference lift also edits `packages/adr/src/write.ts` (`planLink`, around lines 1114-1179) and may run at the same time; whichever lands second rebases.
- Document the new exports in `packages/ledger/README.md`.

## Done when
- ledger exports the plan helpers, `applyPlan`, the write driver and the editor step, with unit tests, and `stagedEventRefs` in `surfaces/commit-message.ts` (moved here, or by the init-and-hooks lift if that landed first).
- adr's `write.ts` and issues' `plan.ts`, `apply.ts` and `write.ts` use them, and none of the copies listed in the Notes remains in either tool.
- Every write command of both tools writes, stages and commits the same files, with the same messages, trailers, notes and `--json` documents: both tools' existing tests, the index-invariant and model tests included, pass with no change to what they assert.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
