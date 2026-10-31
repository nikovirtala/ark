---
"@nikovirtala/ledger": minor
---

`@nikovirtala/ledger` exports the read side a tool builds its commands on: `readKindLog` (load, fold, the read checks and the projection of a kind's log), `numberToolLog` (display numbers with the committed-index fallback in a shallow clone), `changedSince`, `unavailableReason`, `numberingJson`, `eventsInFoldOrder`, `readSourceLog` (a `--source` read from the local cache), `readSourceSubjects` (a cached source's subjects as `ForeignSubject`s) and the `ForeignSubject` type. adr and issues now use these instead of their own copies; what `list`, `show`, `search` and `for` print, with and without `--source`, is unchanged.
