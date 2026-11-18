# Commit writes by default in logs that init sets up

## Context
adr and issues writes stage their files and commit only with `--commit` or `[policy] auto_commit = true`, and the built-in default of `auto_commit` is false. Most writes commit anyway: 178 of the last 300 commits of ark's `main` carry an `ADR-Event` or `Issue-Event` trailer, so a tool made them, and the README quickstart passes `--commit` on every write. A write left staged is swept into the next plain commit, which then holds another change's events without their trailers. MCP writes have no commit input and commit only with `auto_commit`, so in a log with the starter config an agent's MCP writes stay staged. Committing has a cost: each commit runs the git hooks and signing, and when git refuses it the tool exits 2 (`commit-failed`) with a recovery hint.

## Decision
We will have `adr init` and `issues init` write `[policy] auto_commit = true` in the starter config, with a comment that `--no-commit` only stages.

- The built-in default stays `false`. A log whose config has no `auto_commit` key, which includes every log set up before this change, keeps staging.
- init itself keeps its rule: it commits with `--commit`, or when a config it finds sets `auto_commit`. A first `init` in a repository has no config yet, so it stages unless given `--commit`.
- ark's own `docs/adr/adr.toml` and `docs/issues/issues.toml` set `auto_commit = true`.

Options considered and rejected:
1. *Change the built-in default to `true`*: every repository would start committing after an upgrade, with nothing in its config to show why. A breaking change for logs that stage on purpose.
2. *Keep staging by default*: the quickstart and agents keep passing `--commit` on every write, MCP writes stay staged, and a forgotten flag leaves events for an unrelated commit.
3. *Make a first `init` commit by default too*: it would change what `init` does when `AGENTS.md` has unstaged changes (refused with a commit, staged without one), and `init --setup` writes files a person may want to look at before committing.

## Scope
The starter configs that `adr init` (`packages/adr/src/init.ts`) and `issues init` (`packages/issues/src/init.ts`) write, and ark's own `docs/adr/adr.toml` and `docs/issues/issues.toml`. Not the built-in default of `auto_commit`, and not what `init` itself commits.

## Consequences
Easier: in a log set up by `init`, every write from the CLI or MCP is a commit of its own with its trailers, without a flag, so `adr verify --ref` and `git log --grep` work on each one and no event waits in the index for an unrelated commit.

Harder: every write makes a commit, so it runs the git hooks and asks the signing agent each time. A write that belongs in the same commit as code needs `--no-commit`. A failing hook or signing now meets every write, and its recovery path (`commit-failed`, exit 2) becomes common.

Risk: two defaults exist side by side, and whether a log commits depends on when its config was written. The config file states it, and `--commit` and `--no-commit` override it per command.
