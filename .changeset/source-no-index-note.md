---
"@nikovirtala/ledger": minor
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

`issues list --source`, `issues search --source`, `adr list --source` and `adr search --source` on a cached source without a committed `index.md` say "<source> has no committed index.md" instead of "no main branch", and `adr search --source` now gives that note too. Their `numbering.reason` is `"no-index"`; ledger adds that reason and exports `NO_INDEX_NUMBERING`.
