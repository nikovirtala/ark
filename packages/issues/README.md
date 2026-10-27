# @nikovirtala/issues

Issue tracking kept as event logs in git, built on [`@nikovirtala/ledger`](https://www.npmjs.com/package/@nikovirtala/ledger). An issue is a Markdown description plus append-only event files. Its state (open, in progress, closed), resolution, assignees, labels and relations are computed from the events: what blocks it, which issue a duplicate points to, what is ready to pick up. Issues can link to the repository's architecture decisions with `implements`. See the [design doc](https://github.com/nikovirtala/ark/blob/main/docs/02-issues-v1.md).

Released at 0.x. 0.1.0 brought the issue kind, the library and the `issues` CLI (`init`, `new`, `edit`, `start`, `stop`, `close`, `reopen`, `assign`, `label`, `comment`, `link`, `unlink`, `scope`, `for`, `ready`, `work`, `list`, `show`, `verify`), with `implements` links checked against the repository's own decision log. 0.2.0 adds git hooks (`issues hooks`), a generated `index.md` kept fresh on every write (`issues index`), checks over code (scope globs, anchors, stale anchors), and references into other repositories checked against a local cache (`verify --fetch-sources`, `issues sources fetch`, `list --source`). The MCP server, SKILL.md and search are not in 0.2.0.

## Install

```sh
npm install --save-dev @nikovirtala/issues   # Node 24 or newer, git 2.32.0 or newer
npx @nikovirtala/issues --help                # or run it without installing
```

issues needs Node 24 or newer (`engines: >=24`). It depends on `@nikovirtala/adr` to read decision logs, so installing issues installs adr too, and links its `adr` binary in `node_modules/.bin`.

## Layout

```
docs/issues/
  issues.toml                                  # optional config (or issues.toml at the repository root)
  items/m4p8x2kd-split-orders-service.md       # the description, edited freely
  events/m4p8x2kd/20261020T081030Z-p4d2-opened.yaml
  events/m4p8x2kd/20261021T091512Z-7aq5-started.yaml
  templates/task.md                            # copied from the built-in on first use
```

Each issue has a canonical id (`m4p8x2kd`) and, once its `opened` event lands on the first-parent history of main, a number shown as `?42`. Numbers are never stored or renumbered; files, events, links and commit trailers use the id. Commands take the id, the bare number (`42`, `0042`) or `?42`. In a shell, `?42` unquoted is a glob that can match a file named like `a42`, so type `42` or quote it: `'?42'`. An issue opened on a branch shows its id until the branch merges.

## Commands

```sh
# Set up: write issues.toml and starter templates (bug, feature, task); never overwrites a file.
issues init --template task --template bug --commit

# Open an issue from a template; --section fills a section without an editor.
issues new "Split the orders service" --section goal="Two services." --section done="Both deploy." --commit
issues new "Extract the consumer" --parent 1 --depends-on 3 --label type:feature --template feature --edit

# Edit the description: in $VISUAL or $EDITOR, or by heading and section.
issues edit 42
issues edit 42 --title "Split orders and payments" --section done="All three deploy." --commit

# Work on it: start (assigns you when unassigned), stop, close, reopen.
issues start 42
issues stop 42 --reason "waiting for review"
issues close 42 --commit                                   # done
issues close 42 --resolution wontfix --reason "not needed" # a reason is required unless done
issues close 42 --duplicate-of 17 --reason "same crash"
issues reopen 42 --reason "it came back"

# Assignees, labels and code scope, as whole sets; me is you.
issues assign 42 --add me
issues label 42 --add priority:high       # replaces priority:low when priority is exclusive
issues scope 42 --set "src/orders/**"
issues comment 42 "Picked this up; starting with the consumer."

# Relations: depends-on, part-of, relates-to (the default), and implements to a decision.
issues link 42 17 --rel depends-on
issues link 42 ADR-0007 --rel implements
issues unlink 42 17 --rel depends-on

# Keep index.md generated ([log] index = "committed"); every write keeps it fresh.
issues index [--check] [--commit]

# Git hooks through ark's shared shims, next to adr's.
issues hooks install                      # or: uninstall, print --manager lefthook|husky|pre-commit
issues scope [42] --follow-renames        # what the pre-commit hook does with staged renames

# Other repositories' logs, read from a local cache.
issues sources fetch [<name>]
issues list --source platform

# What to work on.
issues ready [--mine] [--label type:bug] [--limit 10]
issues for src/orders/consumer.ts [--all]
issues work 42                            # your current issue in this worktree; --clear removes it

# Read and verify.
issues list [--state closed] [--all] [--assignee me] [--label type:bug] [--since ORIG_HEAD]
issues show 42 [--history] [--commits] [--no-comments]
issues verify [--staged | --base origin/main] [--fetch-sources] [--format text|json|github]
```

Every command takes `--json`, `--root <dir>` (the log directory) and `--help`; reads also take `--ref <ref>`, and writes refuse it. Every write stages what it writes and commits only with `--commit` (or `[policy] auto_commit`), with a Conventional Commits subject (see [Commit subjects](#commit-subjects)) and one `Issue:`/`Issue-Event:` trailer pair per issue and event type. `-m` gives your own message; the trailers join its last paragraph when that is a trailer block. An event write commits the issue's events directory, so an unstaged edit of a committed issue's description never blocks `close --commit` and is never swept into it. When the commit takes an issue's `opened` event (the issue was opened without `--commit`), it also takes that issue's staged description and template, and the same for any issue it references that isn't committed yet. It refuses with exit 2, writing nothing, when one of those files has unstaged changes, isn't tracked or is missing.

`list` shows open and in-progress issues unless you pass `--state` or `--all`; `list --since <rev>` shows the issues closed, reopened or assigned to you since `<rev>`, each marked `[new: closed]` and so on (the post-merge hook runs it with `ORIG_HEAD`). `ready` lists open issues that are not blocked, not assigned and have no open child, in `[labels] priority` order, then by number; `--mine` adds the issues assigned to you, first. An issue is blocked while the canonical issue of one of its dependencies isn't closed (a dependency closed as a duplicate blocks until the issue it duplicates is closed).

## Exit codes and JSON

- **0**: success, including a write that only adds warnings or writes nothing (an existing link, an unchanged set).
- **1**: failing findings from `verify`, or a write the log's rules forbid: an illegal transition, a missing reason, a cycle, a second parent, a duplicate of a duplicate, two labels of an exclusive prefix, an incomplete draft with `--commit`, or an agent close the policy forbids. Nothing is written, and the findings are in the output.
- **2**: the tool can't run: bad usage (unknown command, flag or issue, a qualified issue where none is allowed, `--ref` on a write), config, environment or internal errors, and a source `verify --fetch-sources` couldn't fetch. Nothing is written, except when git refuses a `--commit`: the write is then staged and the error says how to finish the commit.

With `--json`, stdout carries exactly one JSON document: `issues-write/v1` for every write command, `issues-list/v1`, `issues-show/v1`, `issues-ready/v1`, `issues-for/v1`, `issues-work/v1`, `issues-init/v1`, `issues-index/v1`, `issues-hooks/v1`, `issues-sources/v1`, ledger's `ledger-findings/v1` for `verify`, or `ark-error/v1` when the command exits 2. Warnings and notes go to stderr.

## Config (`issues.toml`)

Every key is optional. `issues init` writes this starter file:

```toml
# issues configuration. Every key is optional: https://github.com/nikovirtala/ark/tree/main/packages/issues#config-issuestoml
[log]
default_template = "task"
# "none", or "committed" to keep index.md generated and fresh in every commit (ADR-0010)
index = "none"

[labels]
exclusive = ["priority", "type"]

[policy]
close_requires_human = false
mcp_can_close = true

[commit]
# {title} holds the title in quotes for new, and the issue's number (or id on a branch) with its title in quotes for every other write, as in: close ?42 "split the orders service".
# subject = "docs(issues): {action} {title}"
```

Every key, with its default or an example:

```toml
[log]
root = "docs/issues"            # read from <repo>/issues.toml; the default
default_template = "task"
main_branch = "origin/main"     # the ref numbers come from; default origin/HEAD, origin/main, main, …
index = "none"                  # or "committed": every write keeps index.md fresh, verify checks it

[labels]
exclusive = ["priority", "type"]               # an issue holds at most one label per prefix
priority = ["priority:high", "priority:low"]   # ready's order, highest first

[policy]
close_requires_human = false    # true: agents can't close issues
mcp_can_close = true            # false: agents can't close issues
auto_commit = false             # commit writes without --commit

[verify]
fail_on = "error"               # or "warning"

[commit]
subject = "docs(issues): {action} {title}"   # the default; --message overrides it

[scope]
anchor_keyword = "issue"        # the default: anchors read issue:<id>
anchor_exclude = ["**/*.md"]    # files never searched for anchors; default []

[hooks]
index = "check"                 # or "stage": pre-commit regenerates and stages a stale index.md
scope_follow_renames = "stage"  # or "warn", "off": what pre-commit does with renames of scoped files

[[sources]]                     # other repositories' logs, checked against a local cache
name = "platform"
kind = "issues"                 # or "adr"; the name adr is reserved for this repository's decision log
url = "https://github.com/example/platform.git"
ref = "main"
```

The config is `<repo>/issues.toml`, whose `[log] root` chooses the log directory, or `<root>/issues.toml`. `--root` uses a repository-level file that names the same root, and overrides one that names another root with a warning.

`implements` targets decisions in the repository's own decision log, found as adr finds it (`adr.toml`, `docs/adr`); `adr:<id>`, the id, the number and `ADR-0007` all work, and the link is stored as `adr:<id>`. issues shows the same decision numbers as `adr list`, including in a shallow clone when adr's `index.md` is committed. A link to a decision that isn't accepted is a warning.

## Commit subjects

The `[commit] subject` template's `{title}` slot holds the title in quotes for `new`, and the issue's number (or its id on a branch) with its title in quotes for every other write, so `git log --oneline` reads without `issues show`. The title is the one the commit holds, so an edited heading is what the subject says. A title longer than the description's 72 characters is shortened inside the quotes, with the full title in the body.

| Write | Subject |
| --- | --- |
| `new` | `docs(issues): open "split the orders service"` |
| `edit` | `docs(issues): edit ?42 "split the orders service"` |
| `start`, `stop` | `docs(issues): start work on ?42 "split the orders service"` |
| `close` | `docs(issues): close ?42 "split the orders service"`, `… as won't fix`, `… as a duplicate of ?17` |
| `reopen`, `comment` | `docs(issues): reopen ?42 "split the orders service"`, `comment on ?42 "…"` |
| `assign`, `label`, `scope` | `docs(issues): set the scope of ?42 "split the orders service"` |
| `link`, `unlink` | `docs(issues): link ?42 "split the orders service" to ?17`, `unlink ?42 "…" from ?17` |
| staged events of other types swept in | `docs(issues): link and scope ?42 "…"`; `update ?42 "…"` beyond three verbs; `open and link ?42 and 1 other issue` across issues |
| `init`, `index --commit` | `docs(issues): set up the issue log`, `docs(issues): regenerate the issue index` |

A custom template must leave 20 characters for the title at the longest action (`reopen, unlink and comment on`); one that doesn't is refused when the config loads.

## Hooks and CI

`issues hooks install` registers issues in ark's shared hook shims (one per hook, next to adr's when both are installed):

- **pre-commit**: follows staged renames into scope globs (`[hooks] scope_follow_renames`), checks `index.md` (or regenerates and stages it with `[hooks] index = "stage"`), then runs `verify --staged`. `--staged` checks the issues the staged files touch, or every issue when a staged change touches `issues.toml`, the templates or the decision log, because a staged `adr reject` or `mcp_can_close = false` can break issues nothing else touches.
- **commit-msg**: adds an `Issue`/`Issue-Event` pair per staged issue and event type, and `Issue: <id>` for your current issue (`issues work`) on every commit, adr's included. A message that says `fixes ?42`, `closes ?42` or `resolves ?42` for an issue with no staged `closed` event gets a note: issues never close from commit messages, so run `issues close 42` in the pull request.
- **pre-push**: `verify --base @{upstream} --ref HEAD --fetch-sources`.
- **post-merge**: `list --since ORIG_HEAD`.

The checks `verify` runs include the code checks: an `issue:<id>` anchor naming a missing issue is an error, one naming a closed issue a warning (`issue/stale-anchor`). A scope glob that matches no tracked file is an error only while the issue is in progress: an open issue's globs may name code that doesn't exist yet, because the work is still planned, and a typo is still caught by `issues scope`'s note, which says when verify will report it. `issues start` notes each glob that still matches nothing, since from that commit verify (and the pre-commit hook) reports it.

With `index = "committed"`, every write keeps `index.md` fresh in the same commit, and `verify` reports a stale one (`index/stale`). The index doesn't read other repositories, so an issue blocked only by an open issue in a source shows as Ready there; `issues ready` reads the cached copy.

## Other repositories

References into `[[sources]]` logs (`platform:m4p8x2kd`) are checked against a local cache kept in the repository's git directory. Plain `verify`, the pre-commit hook and every read and write use only the cache and never the network: a referenced source that isn't cached gives one `sources/not-fetched` warning. `verify --fetch-sources`, for CI and the pre-push hook, fetches each source first, and a failed fetch exits 2. `issues sources fetch` refreshes the cache by hand. A ref may be a branch, a tag or a full commit; a tag or commit keeps CI reproducible. `verify --json` records the commit each source resolved to. `link`, `new --parent`/`--depends-on` and `close --duplicate-of` into a cached source refuse a missing target (`issue/reference-missing`, exit 1); into an uncached one they write with a note. `issues list --source platform` lists a cached source's issues with its numbers.

Fetching uses plain git and its credentials. For a private source in CI, use an `insteadOf` URL with a token from the CI secret store (`git config --global url."https://x-access-token:${TOKEN}@github.com/".insteadOf "https://github.com/"`) or an SSH deploy key.

## Agents

An agent using the CLI sets `ARK_AGENT=<agent-id>`, and `ARK_ON_BEHALF_OF=<email>` for the person it acts for. Its events are recorded as the agent, acting on behalf of that address; without `ARK_ON_BEHALF_OF`, on behalf of the git user, with a note on stderr and in the JSON `notes`.

Agents may close issues they finished, unlike accepting decisions, because a closed issue reopens. An agent's `closed` event must have a reason saying how the issue's Done when conditions were met (`issue/agent-reason-required`). With `close_requires_human = true` or `mcp_can_close = false`, an agent's close is refused with exit 1 (`issue/agent-closed`). These are rules of the log: `verify` checks every applied close, so after you turn either key on, a full `verify` reports earlier agent closes too, while `verify --base` reports only the issues a change touches.

## Library

The CLI is a thin layer over the library, which returns the same JSON documents.

```ts
import { closeIssue, listIssues, openIssueLog, readIssues, readyIssues, verifyIssues } from "@nikovirtala/issues";

const log = await openIssueLog({ cwd: process.cwd() });
const read = await readIssues(log);
const { issues } = readyIssues(read, { labels: ["type:bug"] });
const findings = await verifyIssues(log, { type: "full" });
```

`initIssueLog`, `openIssue`, `editIssue`, `startIssue`, `stopIssue`, `closeIssue`, `reopenIssue`, `assignIssue`, `labelIssue`, `scopeIssue`, `commentIssue`, `linkIssue` and `unlinkIssue` write; `listIssues`, `showIssue`, `readyIssues`, `issuesFor` and `issueCommits` read; `resolveIssue` and `resolveTarget` turn arguments into ids; `setCurrentIssue`, `readCurrentIssue` and `clearCurrentIssue` manage the current issue; `stateHeader` gives the header `show` prints.

`@nikovirtala/issues/kind` exports only the issue kind (`issueKind`, made with ledger's `defineKind`), its relation graph (`issueGraph`) and their types, without any CLI code, for tools that fold issue logs themselves:

```ts
import { issueKind } from "@nikovirtala/issues/kind";
```

## Not yet included

- **Agents:** `issues mcp`, `issues init --skill` and `issues search`.
