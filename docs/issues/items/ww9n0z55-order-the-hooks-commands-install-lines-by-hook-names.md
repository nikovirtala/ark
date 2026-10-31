# Order the hooks command's install lines by HOOK_NAMES

## Goal
Make `hooksCommand` in `packages/ledger/src/cli/hooks-command.ts` sort its install lines by ledger's `HOOK_NAMES`, so a hook added to that list is printed in its place and not first.

## Notes
Found in code review v1 of the first slice of ?43 (hook steps, hooks command and editor).

- `packages/ledger/src/cli/hooks-command.ts:43` defines `HOOK_ORDER` as a literal copy of `HOOK_NAMES` (`packages/ledger/src/hooks/shim.ts:12`), carried over from the tools' `order()` helpers. `order` (`:53`) ranks each install line by its index in `HOOK_ORDER`.
- `packages/ledger/src/surfaces/tool-hooks.ts:65` and `packages/ledger/src/hooks/registrations.ts:16` already use `HOOK_NAMES`. If a hook is added to `HOOK_NAMES` only, `order` ranks its line -1 and the install text prints it first.

## Done when
- `packages/ledger/src/cli/hooks-command.ts` orders the install lines by `HOOK_NAMES` and defines no hook list of its own.
- `adr hooks install` and `issues hooks install` print the same text as before (their `cli/hooks.test.ts` pass unchanged).
