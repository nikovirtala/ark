# Drop the unreachable AGENTS.md restore from init's rollback

## Goal
Make the rollback in `initToolLog` (`packages/ledger/src/surfaces/tool-init.ts`) only remove the files init wrote, without the AGENTS.md restore branch that can never run.

## Notes
Found in code review v1 of the second slice of ?43 (shared init steps).

- `packages/ledger/src/surfaces/tool-init.ts:288-291`: the catch block restores AGENTS.md when it is in `written` and was replaced (the `replaced` flag set at `:283`).
- AGENTS.md is the last write, and `written.push(AGENTS)` (`:284`) is the last statement in the try. If AGENTS.md is in `written`, nothing after it can throw, so the restore never runs. Both tools had this branch before ?43 moved it into ledger.
- The JSDoc at `:131` says a failed write "restores AGENTS.md", which cannot happen.
- The ledger test "leaves AGENTS.md as it is when replacing it fails" passes because `replaceFile` refuses before it writes, not because the restore ran.

## Done when
- The rollback in `packages/ledger/src/surfaces/tool-init.ts` only removes written files: the AGENTS.md restore branch and the `replaced` flag are gone, and the JSDoc no longer says "and restores AGENTS.md".
- `packages/ledger/src/surfaces/tool-init.test.ts` passes unchanged.
