# Share exit codes and failing findings across ark tools

## Context
Every ark tool follows the same surface rules, so knowing one means knowing all ([Monorepo](../../00-ark-v1.md#monorepo), Shared conventions). Hooks and CI use a tool's exit code and `--json` output, and roadmap step 6 plans one GitHub Action that runs `verify` for every configured ark tool ([adr: CI checks](../../01-adr-v1.md#ci-checks), [Implementation notes and roadmap](../../00-ark-v1.md#implementation-notes-and-roadmap)).

## Decision
Every ark CLI exits 0 on success, 1 on failing findings or a write the log's rules forbid (nothing is written), and 2 on usage, config and environment errors, printing an `ark-error/v1` document under `--json`.

Error findings always fail. Warnings fail only where a tool is configured to fail on them: ledger takes `failOn: "warning"`, and adr exposes it as `[verify] fail_on = "warning"` in `adr.toml` (default `"error"`) ([Monorepo](../../00-ark-v1.md#monorepo), [adr: Repository layout](../../01-adr-v1.md#repository-layout)).

## Scope
The command-line surface of every ark tool, through ledger's shared CLI runner and `verify` command, and every hook and CI step that reads those exit codes.

## Consequences
- Hooks, CI and the planned shared Action can treat every tool alike, and a repository can make warnings fail without changing tools.
- A tool can't define its own exit codes.
- With the default `fail_on = "error"`, warnings are reported but don't fail the build, so they rely on reviewers reading them.
