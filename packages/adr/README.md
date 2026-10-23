# @nikovirtala/adr

Architecture decision records kept as event logs in git, built on [`@nikovirtala/ledger`](https://www.npmjs.com/package/@nikovirtala/ledger). A decision is a Markdown body plus append-only event files. Its status (proposed, accepted, rejected, withdrawn, deprecated, superseded) is computed from the events, the body is frozen by its hash once accepted, and supersession chains always lead to the decision in force. See the [design doc](https://github.com/nikovirtala/ark/blob/main/docs/01-adr-v1.md).

This is phase 1 ("Core"), released at 0.x: the decision kind, the library and the `adr` CLI with `new`, `accept`, `supersede`, `list`, `show` and `verify`.

## Install

```sh
npm install --save-dev @nikovirtala/adr   # Node 24 or newer, git 2.32.0 or newer
npx @nikovirtala/adr --help               # or run it without installing
```

## Layout

```
docs/adr/
  adr.toml                                   # optional config (or adr.toml at the repository root)
  decisions/k3f9q8a1-use-aurora-for-orders.md
  events/k3f9q8a1/20261016T081030Z-p4d2-proposed.yaml
  events/k3f9q8a1/20261016T091512Z-7aq5-accepted.yaml
  templates/nygard.md                        # copied from the built-in on first use
```

Each decision has a canonical id (`k3f9q8a1`). Accepted decisions also get a number (`ADR-0001`), assigned in the order their acceptances land on the first-parent history of main and never stored or renumbered. Commands take an id or a number in any form: `k3f9q8a1`, `7`, `0007`, `ADR-7`, `adr-0007`.

## Commands

```sh
# Propose: render a draft from a template, write the body and the proposed event, and stage them.
adr new "Use Aurora for orders" --section context="We need SQL." --section scope=services/orders
adr new "Use Aurora Serverless" --supersedes ADR-0002 --template madr --edit

# Accept: lint the draft, hash the body, and write accepted (plus superseded on each declared target).
adr accept k3f9q8a1 --commit

# Supersede an accepted decision by another accepted one.
adr supersede ADR-0001 --by ADR-0002 --reason "Aurora fits the query load" --commit

# Read: list with computed status, show one decision with its state header.
adr list --status accepted
adr show ADR-0001 --history
adr list --ref v1.2.0                      # time travel: the log as of any ref

# Verify the log: the whole tree, a range, or the staged changes (for a pre-commit hook).
adr verify
adr verify --base origin/main --format github
adr verify --staged
```

- `new` takes `--template <name>` (default `nygard`; built-ins `nygard`, `madr`, `y-statement`, or your own `<root>/templates/<name>.md`), `--section <id>=<markdown>` (repeatable), `--supersedes <decision>` (repeatable), and `--edit`/`--no-edit`. It opens `$VISUAL` or `$EDITOR` with `--edit`, or by default in an interactive terminal; an editor failure never loses your edits and never commits content you didn't confirm.
- Writes stage their files and don't commit, unless you pass `--commit` or set `auto_commit`. A commit holds every file of the decisions it touches (body, events, template), so `adr verify --ref <commit>` is clean, and never your unrelated staged work. It refuses with exit 2 when a file it needs has unstaged changes or isn't tracked. Its `ADR: <id>` and `ADR-Event: <type>` trailers name one event each, in a fixed order, whatever your `trailer.*` config.
- `show` leads with a state header. A decision that isn't in force says so and names what to read instead, for example `SUPERSEDED by ADR-0002 (accepted 2026-10-18). Do not apply this decision; read ADR-0002 instead.`

Every command takes `--json`, `--root <dir>` (the log directory) and `--help`; reads also take `--ref <ref>`, and writes refuse it.

## Exit codes and JSON

- **0**: success.
- **1**: failing findings from `verify`, or a write the log's rules forbid (an illegal transition, a draft that fails its template lint, an agent's acceptance, an unaccepted successor). Nothing is written, and the findings are in the output.
- **2**: bad usage (unknown command, flag or decision, a missing argument, `--ref` on a write), and config or environment errors.

With `--json`, stdout carries exactly one JSON document: `adr-list/v1`, `adr-show/v1`, `adr-write/v1` (for `new`, `accept` and `supersede`), ledger's `ledger-findings/v1` for `verify`, or `ark-error/v1` (`{ "format": "ark-error/v1", "error": { "code", "message" } }`) when the command exits 2. Every key is always present, with `null` where a value is unknown. Warnings and notes go to stderr.

## Config (`adr.toml`)

Every key is optional.

```toml
[log]
root = "docs/adr"               # read from <repo>/adr.toml; the default
default_template = "nygard"
main_branch = "origin/main"     # the ref numbers come from; default origin/HEAD, origin/main, main, …
index = "none"                  # validated now, used in phase 2

[policy]
accept_requires_human = true    # refuse acceptances by an agent
auto_commit = false             # commit writes without --commit
mcp_can_decide = false          # validated now, used in phase 3

[verify]
fail_on = "error"               # or "warning"
```

The config is `<repo>/adr.toml`, whose `[log] root` chooses the log directory, or `<root>/adr.toml`. `--root` uses a repository-level file that names the same root, and overrides one that names another root with a warning.

## Agents

An agent using the CLI sets `ARK_AGENT=<agent-id>`. Its events are recorded as the agent, acting on behalf of the git user, and with `accept_requires_human` on (the default) `adr accept` refuses them with exit 1 (`decision/agent-accepted`). The git identity comes from `user.name` and `user.email` and is never guessed.

## Library

The CLI is a thin layer over the library, and phase 3's MCP server uses the same functions and returns the same JSON documents.

```ts
import { listDecisions, openDecisionLog, readDecisions, showDecision, verifyDecisions } from "@nikovirtala/adr";

const log = await openDecisionLog({ cwd: process.cwd() });
const read = await readDecisions(log);
const { decisions } = listDecisions(read, { status: ["accepted"] });
const findings = await verifyDecisions(log, { type: "full" });
```

`proposeDecision`, `acceptDecision` and `supersedeDecision` write, `resolveDecision` turns an id or number into an id, and `stateHeader` gives the header `show` prints.

`@nikovirtala/adr/kind` exports only the decision kind (`adrKind`, made with ledger's `defineKind`) and its types, without any CLI code, for tools that fold decision logs themselves, such as issues linking to decisions:

```ts
import { adrKind } from "@nikovirtala/adr/kind";
```

## Not yet included

- **Reference checks are local in phase 1.** `verify` checks that `supersedes`, `superseded.by` and `linked.to` name decisions in the same log. Qualified references to other logs (`<source>:<id>`) are skipped; no phase 1 command writes them.
- **Phase 2:** `init`, `reject`, `withdraw`, `deprecate`, `note`, `link`, `scope` and `for`; git hooks; a generated index (and the number fallback for shallow clones); scope globs and code anchors; cross-log reference checks and listing across sources.
- **Phase 3:** an MCP server, a SKILL.md for agents, and search.
