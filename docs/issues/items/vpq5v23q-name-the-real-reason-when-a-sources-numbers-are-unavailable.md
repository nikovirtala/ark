# Name the real reason when a source's numbers are unavailable

## Goal
Make `issues list --source` and adr's `list`/`search --source` say that a cached source has no committed `index.md` when that is why its numbers are unavailable, instead of "no main branch". Found by the conformance and semantic reviews of issues PR 2 (?3).

## Notes
- If a cached source's tree has no `index.md`, `readSourceIssues` (`packages/issues/src/log.ts`, around line 257) and adr's `indexNumbering` (`packages/adr/src/sources.ts:37`) both return ledger's `NO_NUMBERING` (`packages/ledger/src/fold/numbering.ts:22`), whose reason is `no-main-ref`. `unavailableReason` (`packages/issues/src/log.ts:272`, `packages/adr/src/log.ts:195`) renders that as "no main branch".
- In the PR 2 demo (row 5), `issues list --source platform` warned "issue numbers are unavailable (no main branch); issues display by id". The source had a main branch; a source is read at its pinned ref and gets numbers only from its committed index, and this one has `index = "none"`.

## Done when
- `issues list --source <name>` and `adr list --source <name>` (and `adr search --source <name>`) on a cached source without a committed `index.md` give a note saying that the source has no committed index (for example "platform has no committed index.md"), not "no main branch".
- A test in each tool covers it.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
