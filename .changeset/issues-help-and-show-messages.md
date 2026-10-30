---
"@nikovirtala/ledger": minor
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

`issues <command> --help` describes every option: string options name their value (`--rel <rel>`, `--section <id>=<markdown>`), enumerated values and defaults are in the text, and `--no-commit`, `--no-edit` and `--no-comments` have their own rows. ledger's `CommandSpec` options are `CommandOption`s, which add `help`, `value` and `negatedHelp` for `runCli`'s command help; `COMMIT_OPTIONS` and `verifyCommand` describe their options, so adr's `--commit`, `--no-commit`, `-m` and `verify` options are described too.

Changed behaviour:
- The blocked warning says "Finish it first." when one open issue blocks, and "Finish them first." for more.
- `issues show --history` and `issues_get` with `include_history` name on whose behalf an agent acted: `opened by kiro on behalf of <address>`.
