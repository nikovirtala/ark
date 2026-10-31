---
"@nikovirtala/ledger": minor
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

`@nikovirtala/ledger` exports the index code adr and issues shared by copy: `renderLogIndex`, `unstagedLogFiles` and `unstagedIndexText` render a log's `index.md` and explain a stale staged copy, `logIndexCheck` and `runLogIndex` are the `index/stale` check and the `index` run, with the recovery hints `indexRerunHint`, `indexBeforeHint` and `indexAfterHint` and the types `ToolWriteOptions`, `LogIndexJson` and `IndexRun`, and `@nikovirtala/ledger/cli` exports the `indexCommand` factory. `adr index` and `issues index` now use them; their output, JSON documents and `--help` are unchanged.
