# Run every tool's git hooks through one ledger shim per hook

## Context
adr and issues both want pre-commit, commit-msg, pre-push and post-merge hooks, and ark itself wants commitlint on commit-msg. Separate hook files per tool overwrite each other, and hook managers (husky, lefthook) add a dependency and a second configuration (00-ark-v1 'Hooks across tools', 01-adr-v1 'Git hook helpers'). Hooks can be skipped with --no-verify, so they are feedback, not enforcement.

## Decision
Git hooks are ledger's generated sh shims, one per hook, whose registry lists every tool that installed itself (<tool> hooks install); one run invokes each registered tool once and fails if any fails. Tools without ark's CLI register through ledger's installHooks, as ark's commitlint does from scripts/git-hooks.mjs. Repositories with a hook manager paste <tool> hooks print --manager … snippets instead. Hooks never stage into a temporary index (git commit <paths>). CI repeats every check, so hooks stay optional.

## Scope
ledger's Hooks layer (packages/ledger/src/hooks), adr's hooks command and pre-commit steps, and how ark installs its own hooks.

## Consequences
- A repository using several ark tools has one hook per kind of hook, and a new tool adds a line, not a file.
- ark has no husky or lefthook dependency; contributors run pnpm git-hooks install after building.
- The hooks run the work tree's build in ark, so a broken build blocks commits until rebuilt or bypassed.
- A team already on a hook manager keeps it and copies snippets.
