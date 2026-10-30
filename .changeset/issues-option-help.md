---
"@nikovirtala/ledger": minor
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

`issues <command> --help` describes every option, with its value (such as `--section <id>=<markdown>` and `--rel <relation>`, whose values and default `relates-to` are listed) and a line for each negated option (`--no-commit`, `--no-edit`, `--no-comments`); `adr verify --help` and `issues verify --help` describe theirs. `issues show` says "Finish it first." for one open blocker, and `issues show --history` names on whose behalf an agent acted ("opened by kiro on behalf of …"). ledger's `CommandSpec` takes `help` (`OptionHelp` per option) and exports `COMMIT_HELP` for `COMMIT_OPTIONS`.
