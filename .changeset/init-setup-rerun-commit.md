---
"@nikovirtala/ledger": patch
---

`init --setup` with a commit (`--commit` or `[policy] auto_commit`) no longer fails with `git commit failed (exit 128)` when a rerun has nothing to update: it writes nothing and commits nothing.
