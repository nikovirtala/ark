# Title an index-only adr init commit as the decision log

## Goal
Make a committing `adr init` that writes only `index.md` title its commit `docs(adr): set up the decision log`, not "set up the adr agent skill".

## Notes
Found in code review v1 of the second slice of ?43 (shared init steps).

- `packages/adr/src/init.ts:95`: `commitTitle` picks "the decision log" when `logFiles > 0` and "the adr agent skill" otherwise.
- adr runs ledger's index step with `indexStep: "after-skill"` (`packages/adr/src/init.ts:87`), and `initToolLog` takes `logFiles = files.length` before that step (`packages/ledger/src/surfaces/tool-init.ts:207-208`), so `index.md` never counts as a log file.
- A committing `adr init` that finds the config and templates, has `[log] index = "committed"`, gets no `--skill` and writes only `index.md` therefore has `logFiles` 0 and is titled "set up the adr agent skill".
- issues (`indexStep: "before-skill"`) counts `index.md` and titles the same run as its log. The base code before ?43 behaved the same way, and the lift kept it on purpose.

## Done when
- That run's commit subject is `docs(adr): set up the decision log`: adr titles by whether init wrote anything other than the skill files.
- A test in `packages/adr/src/init.test.ts` covers the index-only run.
