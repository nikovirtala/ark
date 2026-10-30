# Drop the "no main branch" note for a source that isn't fetched

## Goal
Make `issues list/search --source <name>` and `adr list/search --source <name>` print only the "not fetched" note for a `[[sources]]` entry that isn't fetched, without also saying "no main branch".

## Notes
Code review finding (LOW) of pull request #61 (?9, ?10 and ?11 of ?31). The approved design left it out of scope for the code review to file.

- `packages/issues/src/log.ts:245-251` and `packages/adr/src/sources.ts:136-142` still read an unfetched source with ledger's `NO_NUMBERING`, whose reason is `no-main-ref`.
- As a result, `issues list --source platform` prints `platform not fetched; run issues sources fetch` together with `issue numbers are unavailable (no main branch); issues display by id` (from `readNotes` → `numberingNote`).

## Done when
- For a `[[sources]]` entry that isn't fetched, `issues list/search --source <name>` and `adr list/search --source <name>` print only the "not fetched" note and not "no main branch".
- A test in each tool covers it.
