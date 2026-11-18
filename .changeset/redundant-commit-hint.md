---
"@nikovirtala/ledger": minor
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

A write run at a terminal with `--commit` in a log whose config sets `[policy] auto_commit = true` ends with `hint: --commit isn't needed here: [policy] auto_commit = true commits every write` on stderr. Scripts, agents and `--json` don't get it, because stdin or stdout isn't a terminal there, and a flag passed on purpose to commit whatever the config says shouldn't nag. In `@nikovirtala/ledger/cli`, `runCli` prints the hints `commitChoice` gives.
