---
"@nikovirtala/ledger": minor
---

`@nikovirtala/ledger` exports `toolConfigReader`, a reader of a `<tool>.toml` whose errors name the file and key, `parseSharedKeys`, which validates the keys every tool config has (`[log] default_template`, `main_branch` and `index`, `[policy] auto_commit`, `[verify] fail_on`, `[scope] anchor_keyword` and `anchor_exclude`, `[hooks] scope_follow_renames` and `index`, and `[commit] subject`), and `parseNumberingKeys`, which validates only `[log] main_branch` and `index`. adr and issues now use these instead of their own copies; they accept and refuse the same values as before.
