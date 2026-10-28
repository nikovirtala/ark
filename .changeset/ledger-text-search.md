---
"@nikovirtala/ledger": minor
"@nikovirtala/adr": patch
---

Add `foldText`, `searchTerms`, `countOccurrences` and `searchExcerpt` (and the `FoldedText` type) to ledger's root entry: the case- and accent-insensitive folding, query rules and excerpts of adr's search, shared so every ledger-based tool's search matches the same way. adr's search now uses them; its results and messages are unchanged.
