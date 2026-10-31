---
"@nikovirtala/ledger": minor
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

`@nikovirtala/ledger` exports the git hook code and the editor adr and issues shared by copy: `hookRegistrations` lists a tool's hook commands in hook order, `toolHookCommands`, `installToolHooks`, `uninstallToolHooks`, `printToolHooks` and `toolHooksResult` are a tool's `hooks install`, `uninstall` and `print` with their `ToolHooksJson` document, `readCommitMessage`, `stagedEventTrailers` and `stagedEventRefs` are the shared part of the `commit-msg` step, and `runPreCommitHook` is the `pre-commit` step, with the types `ToolHooksSpec`, `ToolHookRegistration`, `FollowRenames`, `PreCommitHookOptions` and `PreCommitHookResult`. `@nikovirtala/ledger/cli` exports the `hooksCommand` factory and `editorFromEnv` with its `Edit` type. `adr hooks`, `issues hooks` and both tools' editors now use them; their output, JSON documents and `--help` are unchanged.
