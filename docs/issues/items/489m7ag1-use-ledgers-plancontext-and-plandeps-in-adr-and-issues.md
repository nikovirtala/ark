# Use ledger's PlanContext and PlanDeps in adr and issues

## Goal
Drop the tools' own copies of ledger's write-plan types: adr and issues use ledger's `PlanContext` and `PlanDeps`, and issues declares its trailer keys once.

## Notes
Found in code review v1 of the change for ?42 (its findings 3 and 4).

- ?42 exports `PlanDeps` and `PlanContext` from ledger (`packages/ledger/src/surfaces/write-driver.ts:51`, `:57`), but `packages/adr/src/write.ts:143` and `packages/issues/src/plan.ts:74` keep their own `PlanContext` interfaces with the same four fields, and both `WriteDeps` (`packages/adr/src/write.ts:1394`, `packages/issues/src/write.ts:96`) repeat `now`/`random` instead of extending `PlanDeps`. They drift as soon as ledger's context gains a field.
- ?42 added `TRAILER_KEYS = { subject: "Issue", event: "Issue-Event" }` to `packages/issues/src/plan.ts:177` for `eventPairs`, while `packages/issues/src/apply.ts:24` keeps its own copy for `applyPlan`. Export it from one module and import it in the other.

## Done when
- Neither tool declares its own `PlanContext`; each re-exports or aliases ledger's.
- Both `WriteDeps` extend `PlanDeps`.
- issues declares its trailer keys once.
- Every adr and issues test passes unchanged.
