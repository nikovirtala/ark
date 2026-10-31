# issues: Design Doc

Oct 22, 2026 · @Niko Virtala

## Summary

issues, published as the npm package @nikovirtala/issues, is a CLI and MCP server that keeps a project's issues in git as markdown files, with an append-only event log for everything that happens to them. State is never written into an issue file; it is computed from the events every time someone, human or agent, reads it.

It is the sibling of [adr](01-adr-v1.md) and follows the same principles, with one deliberate difference: an issue's description is a living document that may be edited, while an accepted decision is frozen. Everything else about an issue (state, assignees, labels, comments, relations) is an event.

Both are part of [ark](00-ark-v1.md) and built on its shared core, ledger. issues defines the issue kind: its event types, state machine, invariants, projection, commands and MCP tools. ledger provides the rest: storage, ids, the event envelope, folding, verification, sources, scope, templates, hooks and the test harness. This document describes the issue kind and points to the ark design wherever ledger does the work.

**Problem.** Forge issue trackers live beside the code, not in it. An issue's state does not travel with the branch that fixes it, the tracker is unreachable offline, and agents need API tokens and network access to read it. Markdown TODO files in the repo solve that, but they edit status in place, so parallel branches conflict and nobody can tell who closed what, or when.

**Goals**

- Current state is derivable from the repository alone: no server, no database, works offline.
- State moves with the code. Closing an issue is an event in the same pull request as the fix, so main says closed exactly when the fix lands.
- Humans and agents use the same operations, through a CLI and an MCP server over one core library.
- Every read returns computed state, blockers and duplicates, so nobody starts work on a closed, blocked or duplicate issue by accident.
- Parallel branches merge without conflicts in the issue log.
- Issues link to code and to adr decisions, so "what is open in this file?" and "which work implements this decision?" are one query each.
- Templates are per-repository and replaceable without touching existing issues.

**Non-goals**

- A hosted service, web UI or interactive board.
- Two-way sync with GitHub Issues, Jira or Linear. One-way import is on the roadmap; mirroring is not.
- Notifications, real-time collaboration, time tracking or sprint planning.
- Replacing pull request review as the place where work is accepted.

## Core principles

The design treats an issue as a living description plus a stream of events, with state as a projection and git as the only storage.

1. **Descriptions are living documents.** An issue file says what the work is, and it may be edited at any time as understanding improves. Git is its history. This is the one place issues differs from adr, because a stale description of work is worse than a changed one.
2. **Everything else is an event, never an edit.** State, assignees, labels, comments and relations are small, append-only event files. No existing event file is rewritten, and no state ever appears in an issue file.
3. **Git is the database.** No index service. Current state is folded from event files on read. A generated index can be committed for browsing, but it is never the source of truth.
4. **State travels with the branch.** Because events are files in the tree, a branch sees its own view: the branch that fixes an issue also closes it, and main agrees only when that branch merges.
5. **One core, two surfaces.** The CLI and the MCP server are thin adapters over the issue kind and ledger, so humans and agents get identical semantics and validation.
6. **Reads are never stale.** Any read of an issue, through either surface, carries its computed state, its open blockers and, for a duplicate, the canonical issue.
7. **Conflict-free by construction.** One file per event with a unique name means parallel branches only ever add event files, so merges never conflict in the issue log. Concurrent description edits are ordinary text merges, the same as any other markdown in the repo.

## Repository layout

Everything lives under one directory, configurable in `issues.toml`. Events are grouped per issue so a fold reads one small directory.

```
docs/issues/
  issues.toml                     # config: default template, labels, policies, index mode; or issues.toml at the repository root
  templates/
    bug.md
    feature.md
    task.md                       # repo-specific templates live here too
  items/
    m4p8x2kd-login-fails-on-safari.md     # displayed as ?42
    r7c3n9wa-split-orders-service.md      # displayed as ?43
  events/
    m4p8x2kd/
      20261020T081500Z-h2kq-opened.yaml
      20261020T090210Z-b7wn-labeled.yaml
      20261021T140033Z-x4md-started.yaml
      20261022T101500Z-c9fa-closed.yaml
    r7c3n9wa/
      20261021T112000Z-p4d2-opened.yaml
      20261021T112001Z-z9c4-linked.yaml
  index.md                        # generated projection, optional
```

Event file names are `<UTC timestamp>-<4 random chars>-<type>.yaml`, ledger's naming for every kind. They sort chronologically in a directory listing, and two branches can never produce the same name.

An issue file holds the title as its first heading and the description below it, and nothing else: no frontmatter, no state. The slug in its name is fixed at creation and never follows a retitle, because the tool finds files by id.

**Identifiers.** Ids come from ledger, the same as adr's. Each issue gets a canonical id at creation: 8 Crockford base32 characters in lowercase (40 random bits, in the alphabet ULIDs use), such as `m4p8x2kd`. Parallel branches cannot realistically collide, so file names, events and links use only this id and nothing is ever renamed. CI still rejects duplicates.

**Display numbers** such as ?42 are derived, never stored. The ? prefix keeps forges from auto-linking them to their own issues and pull requests. The projection numbers issues in the order their `opened` event first landed on the main branch, read with `git log --first-parent`. Main's history is append-only, so a number is stable once assigned. An issue opened on a branch displays by id until it merges. Every command and MCP tool accepts the canonical id, the bare number or the prefixed number. The prefix is fixed, not configurable. In a shell, an unquoted `?42` is a glob that can match a file such as `a42`, so type the bare number (`issues show 42`) or quote it (`'?42'`).

Numbering needs main's history. With `index = "committed"`, a shallow clone reads the numbers recorded in the committed `index.md`; without one, issues display by id until you fetch the history (`git fetch --unshallow`). On a branch, these are the numbers the issues opened in the branch's commits will get once it merges (the index projects them). Decisions linked with `implements` show `ADR-0007` in a shallow clone too, because their numbers come from adr's own committed `index.md` (ADR-0010).

**Any issue log topology.** The tool prescribes no organizational structure. An issue log per repository, one shared tracker repository, or both together all work the same way. Sources are a ledger feature, configured the same way in every ark tool. An issue log can reference other logs as read-only sources, pinned to a git ref:

```toml
[[sources]]
name = "platform"
kind = "issues"                  # issues | adr
url = "git@github.com:example/platform.git"
ref = "main"
```

Inside the source repository, the log is read at the entry's `root` when it sets one, otherwise at the kind's default root; a source with neither is a configuration error.

Cross-log references use a qualified id, `platform:m4p8x2kd`, whose prefix is the `name` of the `[[sources]]` entry; `kind` only says what kind of log the source holds. Each log owns its issues' events, so `linked` can point into any source of the right kind, but an issue can only be closed or reopened in the log that owns it, and a duplicate's `of` names an issue of the same log. A qualified reference naming no `[[sources]]` entry is an error (`issue/unknown-source`); the log's own name (`issues:`) is not an implicit name for the log itself, so local issues are referenced by id. References into other repositories are checked against ledger's local cache of each source (see the ark design's Sources layer): cache only by default, with `verify --fetch-sources` (CI and the pre-push hook) fetching first and exiting 2 when a fetch fails, and `issues sources fetch` refreshing it by hand. A referenced source that isn't cached gives one `sources/not-fetched` warning. A write that links into a cached source refuses a missing target (`issue/reference-missing`); into an uncached one it writes the link with a note. `issues list --source <name>` lists a cached source's issues.

**adr is a source too.** When the repository has an adr decision log, it is discovered automatically as a source named `adr` (so `name = "adr"` is reserved in `[[sources]]`), so `adr:k3f9q8a1` references a decision with the same syntax as any other cross-log reference. issues reads the decision log by importing adr's kind from @nikovirtala/adr/kind and folding it with ledger, so it never shells out to adr or reimplements its rules. Decisions in other repositories are plain sources with `kind = "adr"`.

A minimal config:

```toml
[log]
root = "docs/issues"  # read from <repo>/issues.toml; the default, any path works
default_template = "task"
index = "committed"             # committed | none; issues 0.1.0 refuses committed until the index ships

[labels]
exclusive = ["priority", "type"] # at most one label per prefix, e.g. priority:high
priority = ["priority:high", "priority:low"] # ready's order, highest first

[policy]
close_requires_human = false
mcp_can_close = true            # agents may close what they finished
auto_commit = false
```

`[labels] priority` orders `issues ready`: an issue ranks by the first of its labels in the list, issues with none come after, then by number. issues 0.1.0 refuses `index = "committed"` with a configuration error (exit 2), because it can't keep `index.md` fresh yet and a committed index must never go stale.

## Event schema

Every event is one YAML file in ledger's shared envelope, with `kind: issue` and a type-specific `data` block validated against the issue kind's JSON Schema. The envelope is defined in the ark design; only `data` and the event types belong to issues.

```yaml
envelope: ledger/v1
kind: issue
schema: issue/v1
id: 01M5HHPQ50Q2M8K4X9ZTH6C9FA  # ULID, unique across the repo
subject: m4p8x2kd
type: closed
at: 2026-10-22T10:15:00Z
actor:
  kind: agent              # human | agent
  name: Claude Code
  email: null
  agent: claude-code       # MCP client name when kind = agent
  on_behalf_of: niko@example.com
reason: Fixed by normalizing the cookie SameSite attribute.
data:
  resolution: done
```

| Type | Required `data` | Changes state | Notes |
| --- | --- | --- | --- |
| `opened` | `title`, `template`, `template_version`; optional `parent` | yes | Must be an issue's first event; `parent` is the first `part-of` link, removed with `unlinked` like any other |
| `started` | none | yes | Moves to `in-progress`: someone is working on it |
| `stopped` | none | yes | Work paused without finishing; back to open |
| `closed` | `resolution` (`done`, `wontfix`, `duplicate`, `obsolete`); `of`, an issue of the same log, when duplicate | yes | `reason` required unless `done`, and always from an agent |
| `reopened` | none, `reason` required | yes | Back to open from closed |
| `assigned` | `set: [people]` | no | Replaces the assignees as a whole; the latest one wins |
| `labeled` | `set: [labels]` | no | Replaces the labels as a whole; exclusive prefixes enforced |
| `commented` | `text` | no | Discussion and progress notes; the additive alternative to editing the description |
| `linked` | `to`, `rel` (`depends-on`, `part-of`, `relates-to`, `implements`) | no | `implements` points at an adr decision; the other relations point at issues |
| `unlinked` | `to`, `rel` | no | Removes a relation; dependencies change as work is understood |
| `scoped` | `set: [globs]` | no | Replaces the issue's code scope as a whole; the latest one wins |

Ordering within an issue is by `at`, then `id`. The author-supplied `at` is trusted for ordering, while git history remains the audit trail of when each event actually landed. Ordering and unknown-field handling are ledger's rules, identical for every kind.

**Set events, not add and remove.** `assigned`, `labeled` and `scoped` carry the complete set rather than a delta. Two branches that each add a label then produce two events, and the later one wins instead of both being applied. That loses a label in a race, but it keeps the fold trivial and the result visible in one event. The CLI still offers `--add` and `--remove`; it computes the new set from current state. issues writes them with ledger's set-event helper, which adr's `scoped` events introduced in adr phase 2a.

**Relations are directional and stored once.** `A depends-on B` is written on A only; the projection derives `blocks` on B. `part-of` builds the parent and child tree: an issue has at most one current parent. Both `part-of` and `depends-on` must stay acyclic; the other relations may form any graph. `depends-on` is acyclic over the effective graph, which also follows a dependency closed as a duplicate to its canonical issue, so a cycle through a duplicate, including an issue that depends on its own duplicate, is an `issue/cycle` too. A cycle is reported once per strongly connected component, on its smallest id. A link to a missing issue, or to one with no valid `opened` event, never blocks and fails `verify` (`issue/reference-missing`). `unlink` first matches its target verbatim against the stored targets, so a broken link can always be removed. `unlink` is never refused: an error that remains with a changed message, such as a shorter cycle path or parent list after a merge, is reported as a note. Relations are implemented in issues. Step 5 lifts only their checks of qualified references into ledger; the graph stays in issues until another kind needs one.

**Scope: linking issues to code.** Same mechanism as adr: a `scoped` event carries globs, and code can point at an issue with a comment anchor above a symbol, such as `// issue:m4p8x2kd`. This turns TODO comments into tracked work: an anchor instead of a bare `// TODO`, and CI notices when the issue it points at is closed.

## State machine and invariants

An issue has three states, and unlike an ADR none of them is terminal: closed issues reopen when the work turns out unfinished. The states are `open`, `in-progress` and `closed`.

&#91;embedded content: Issue lifecycle · 3 states, closed is reopenable\]

Resolution is part of the closed state, not a state of its own, so `closed: duplicate` and `closed: done` share every rule except the duplicate's link to its canonical issue.

**Invariants enforced on every fold**

- The first event is `opened`, and only one `opened` ever exists per issue.
- `started` applies only to open issues, `stopped` only to in-progress ones, `closed` to open or in-progress ones, and `reopened` only to closed ones.
- `closed` with `resolution: duplicate` requires `of`, which must reference an existing issue of the same log that is not itself a duplicate, so every duplicate points directly at its canonical issue. Duplicates are judged on current state: closing B as a duplicate of C while A is a duplicate of B is refused, so A is re-pointed first (reopen it and close it as a duplicate of C).
- `closed` needs a non-blank `reason` unless the resolution is `done`; an agent's `closed` always needs one.
- `part-of` and `depends-on` graphs are acyclic, an issue has at most one current parent, and an issue cannot relate to itself.
- `implements` targets a decision; `depends-on`, `part-of` and `relates-to` target issues. A qualified target must name a configured source.
- `commented`, `linked`, `unlinked`, `assigned`, `labeled` and `scoped` never change state and are allowed in any state, including closed.
- The current label set (the latest `labeled`) holds at most one label per exclusive prefix.

**Soft rules, reported as warnings rather than errors:** closing a parent while children are still open (any resolution), and closing an issue as done while it still has open dependencies. Starting an issue that is blocked is a warning when you start it, not a CI finding, because whether it was blocked then depends on other issues' event times, which the fold doesn't order.

The states, transitions and invariants above are the issue kind's definition, written as data. ledger replays every history against it and runs the invariants, so issues has no fold loop or transition check of its own, and the diagram and the code cannot drift apart.

## Projection: computing current state

Current state is ledger's fold over each issue's events with the issue kind's reducer, plus a cross-issue pass for derived relations, recomputed on every read. A few thousand small files fold in well under a second.

For each issue the fold produces:

```json
{
  "id": "m4p8x2kd",
  "number": 42,
  "display": "?42",
  "title": "Login fails on Safari",
  "state": "closed",
  "resolution": "done",
  "duplicate_of": null,
  "canonical": "m4p8x2kd",
  "duplicates": [],
  "assignees": ["niko@example.com"],
  "labels": ["priority:high", "type:bug"],
  "parent": null,
  "children": [],
  "depends_on": [],
  "blocks": ["r7c3n9wa"],
  "blocked_by_open": [],
  "blocked": false,
  "ready": false,
  "relates_to": [],
  "implements": ["adr:k3f9q8a1"],
  "applies_to": ["src/auth/**"],
  "comments": 3,
  "template": { "name": "bug", "version": 1 },
  "body_path": "docs/issues/items/m4p8x2kd-login-fails-on-safari.md",
  "opened_at": "2026-10-20T08:15:00Z",
  "closed_at": "2026-10-22T10:15:00Z",
  "state_at": "2026-10-22T10:15:00Z",
  "history": ["opened 2026-10-20", "started 2026-10-21", "closed 2026-10-22"]
}
```

`canonical` follows `duplicate_of` to the issue that actually tracks the work. Both surfaces lead with it, the same way adr leads with `effective`. `title` is the description's first `# ` heading, so a retitle is an edit of the description; `opened.title` is the fallback when there is none.

`blocked` is derived, never stored: it is true while the issue is open or in progress and the canonical issue of any local issue in `depends_on` is not closed, so a dependency closed as a duplicate keeps blocking until the issue it duplicates is closed. `blocked_by_open` lists those canonical issues. `blocks` is the inverse of other issues' `depends-on` links.

**Ready work.** The projection also answers "what can be picked up now?": open, not blocked, not assigned, and with no open children. This is the query agents need most, so it gets its own command and MCP tool. Ready work is ordered by `[labels] priority`, then by number. `issues ready --mine` adds the issues that would be ready but are assigned to you (your email, or the address an agent acts for), listed first.

**Time travel.** Any read accepts a git ref (`--ref v4.2`). The tool then reads files with `git ls-tree` and `git show` instead of the working tree, answering "what was still open when we shipped 4.2?" with no extra storage. Time travel and branch views come from ledger's git layer and work the same in adr.

**Branch view.** Without `--ref`, reads use the working tree, so a feature branch sees its own closes before they reach main. `issues list --ref origin/main` shows the shared view.

**Generated index.** With `index = "committed"`, `issues index` writes `index.md`: a header marking it generated, then in-progress issues, ready issues, blocked issues, other open issues (assigned but not started, or with open children), and recently closed ones, each with number, title, assignees and labels. Every write keeps it fresh, and CI checks it is current. It exists for people browsing on a forge; tools read it only for display numbers in a shallow clone. The index doesn't read other repositories, so an issue blocked only by an open issue in a source shows as Ready there; `issues ready` reads the cached copy.

**No state in issue files, ever.** The tool never writes state, labels or assignees into an issue file, not even as managed frontmatter. Descriptions change for content reasons only, so a diff of an issue file always means the work itself was redescribed.

## CLI surface

The CLI is the human interface and the automation entry point for hooks and CI. Every command writes files and stages them; committing is opt-in with `--commit` or `auto_commit`.

| Command | What it does | Files written |
| --- | --- | --- |
| `issues init [--template bug] [--skill [--skill-dir <path>]]` | Creates the layout, config and starter templates; `--skill` also writes SKILL.md and the AGENTS.md pointer | config, templates, SKILL.md, AGENTS.md |
| `issues new "Title" [--template X] [--parent 12] [--depends-on 13] [--label type:bug] [--section id=…]` | Renders an issue from the template, opens `$EDITOR`; an optional section without content gets no heading | issue file, `opened` event (+ `labeled`, `linked` for `--depends-on`) |
| `issues edit 42 [--title "…"] [--section id=…]` | Opens the description in `$EDITOR`, or replaces the heading and sections without one; `--section <id>=` removes an optional section, and text adds it back in the template's order; a commit that would leave the description failing template lint is refused, as with `new` | issue file |
| `issues start 42` | Marks work begun; assigns you if unassigned | `started` (+ `assigned`) event |
| `issues stop 42` | Pauses work without finishing | `stopped` event |
| `issues close 42 [--resolution wontfix --reason "…"]` | Closes; resolution defaults to `done` | `closed` event |
| `issues close 42 --duplicate-of 17 [--reason "…"]` | Closes as a duplicate of an issue in this log | `closed` event |
| `issues reopen 42 --reason "…"` | Reopens a closed issue | `reopened` event |
| `issues assign 42 --set\|--add\|--remove niko` | Changes assignees | `assigned` event |
| `issues label 42 --set\|--add\|--remove priority:high` | Changes labels | `labeled` event |
| `issues comment 42 "…"` | Adds a comment | `commented` event |
| `issues link 42 17 --rel depends-on` | Records a relation; `unlink` removes one | `linked` / `unlinked` event |
| `issues scope 42 --set\|--add\|--remove "src/auth/**"` | Sets which code an issue concerns | `scoped` event |
| `issues for src/auth/session.ts` | Lists open issues for a file, from scope globs and code anchors | none |
| `issues ready [--mine] [--label X]` | Lists work that can be picked up now | none |
| `issues work 42` | Sets your current issue locally, for commit trailers | `<git dir>/issues-current` (untracked, per worktree) |
| `issues list [--state in-progress] [--all] [--assignee me] [--json]` | Lists issues with computed state; open and in-progress ones unless `--state` or `--all` | none |
| `issues show 42 [--history] [--commits] [--no-comments] [--json]` | Shows description, state, relations, comments (unless `--no-comments`) and history | none |
| `issues search "safari" [--all] [--source <name>]` | Full-text search over ids, numbers, titles, descriptions and comments; every word must match, ignoring case and accents; open and in-progress issues only unless `--all` | none |
| `issues index [--check]` | Regenerates or checks `index.md` | `index.md` |
| `issues verify [--base origin/main] [--staged]` | Runs every invariant check | none |
| `issues template list\|show\|new\|lint` | Template management | templates |
| `issues hooks install\|print` | Git hook integration | hook shims |
| `issues mcp` | Starts the MCP server over stdio | none |

Global flags: `--ref <git-ref>` for time travel, `--json` for machine output, `--root` to override the issue log directory. These are ark's shared flags, with the same meaning and exit codes in every ark tool.

When a command creates a commit, it adds trailers such as `Issue: m4p8x2kd` and `Issue-Event: closed`. Trailers use the canonical id, because a branch commit is written before the issue has a number. They are redundant with the event files but make `git log --grep` and forge searches useful. `issues show --commits` lists every commit whose trailers reference the issue, which is how an issue shows the work done on it without storing commit hashes.

**Current issue.** `issues work 42` records the issue you are working on in an untracked file in the git dir (`<git dir>/issues-current`), so each worktree of a clone has its own. The `commit-msg` hook then adds `Issue: m4p8x2kd` to every commit until you switch or close it. It is a local convenience only and never affects state.

## MCP surface

The MCP server lets agents find work, record what they learn and track what they do, with the same validation as the CLI. Unlike adr, agents are expected to change state here: starting and finishing work is their job. It runs as `issues mcp` over stdio inside the repository, sharing the core library with the CLI.

Tools return the CLI's `--json` documents as `structuredContent`, with a readable text that leads with state headers. Errors are `isError` results with an `ark-error/v1` document, and refusals are documents with `ok: false`. Writes stage their files, and commit only with `auto_commit`. The tool list is fixed at startup, so changing `mcp_can_close` takes a restart; `close_requires_human` and a turned-off `mcp_can_close` refuse closes on every call.

**Tools**

| Tool | Inputs | Returns |
| --- | --- | --- |
| `issues_search` | `query`, `include_closed` (default false), `limit`, `source` | Matching issues with state and a short excerpt; open ones only by default |
| `issues_get` | `id`, `include_history`, `include_comments`, `ref` | Description, computed state, relations, blockers and `canonical` issue |
| `issues_list` | `state`, `label`, `assignee` (each an array), `limit`, `source` | Compact list for orientation |
| `issues_ready` | `label`, `mine`, `limit` | Open, unblocked, unassigned leaf issues, highest priority first |
| `issues_for_path` | `paths` | Open issues concerning each path, from scope globs and code anchors |
| `issues_templates` | none | Available templates with their sections, required flags and guidance |
| `issues_open` | `title`, `template`, `sections` (map of section id to markdown), `labels`, `parent`, `depends_on` | New issue id, path and lint result |
| `issues_update` | `id`, `title`, `sections` | The write document and lint findings |
| `issues_comment` | `id`, `text` | The `commented` event |
| `issues_start`, `issues_stop` | `id`, plus `reason` for `issues_stop` | The state event; `start` assigns the acting user if unassigned |
| `issues_close` | `id`, `resolution`, `reason`, `of` | The `closed` event. Listed only when `mcp_can_close = true`; refuses agents while `close_requires_human = true`; an agent must give a reason |
| `issues_link`, `issues_unlink` | `id`, `to`, `rel` | The relation event |
| `issues_label`, `issues_assign`, `issues_scope` | `id`, `set` / `add` / `remove` | The set event; for `issues_assign`, `me` is the person the agent acts for |

`issues_reopen` is deliberately missing: reopening says a human judged the work unfinished, so agents propose it in a comment instead. This is a restriction of the MCP surface only, not a rule of the log: the CLI lets an agent reopen, and `verify` doesn't check it. `mcp_can_close` and `close_requires_human`, by contrast, are rules of the log that govern agent closes on every surface.

**Resources:** `issues://index` for the projected index, `issues://issue/{id}` for one issue with its state header (`{id}` is the id, the number such as `17`, or `%3F17`; a literal `?` would start the URI's query), and `issues://ready` for the current ready list.

**Prompts:** `issues_from_discussion` turns the current conversation into one issue, filling template sections and listing open questions. `issues_breakdown` splits a large issue into children linked with `part-of`, with `depends-on` between them where order matters, and asks the user before opening them.

**Response design rules**

- Every response that includes a description leads with a state header, before the body text.
- A duplicate always carries a pointer to its canonical issue, for example: `DUPLICATE of ?17 (in-progress). Track work on ?17; read issues://issue/17.`
- A blocked issue lists its open blockers, so an agent never starts work that cannot finish, for example: `BLOCKED by ?12 (open). Finish it first.`
- Issues take structured `sections` rather than free markdown, so the template is enforced and lint errors come back as data the agent can fix.
- Agent-written events get `actor.kind: agent`, the MCP client name in `actor.agent`, and `ARK_ON_BEHALF_OF`, else the git user, as `on_behalf_of`.

## Templates and customization

Templates use ledger's template format, the same as adr's: plain markdown with a frontmatter section schema, so each team defines its own shapes while the tool still validates structure. Each issue records the template name and version it was opened with, and is linted against that version for its whole life.

```markdown
---
template: bug
version: 1
sections:
  - id: summary
    heading: Summary
    required: true
    guidance: One or two sentences on what is wrong, for whom.
  - id: reproduce
    heading: Steps to reproduce
    required: true
    guidance: Numbered steps from a clean state. Include versions.
  - id: expected
    heading: Expected
    required: true
    guidance: What should have happened.
  - id: actual
    heading: Actual
    required: true
    guidance: What happened instead. Paste errors as code blocks.
  - id: done
    heading: Done when
    required: true
    guidance: Observable conditions that make this issue finished.
---
# {{title}}

## Summary
{{summary}}

## Steps to reproduce
{{reproduce}}

## Expected
{{expected}}

## Actual
{{actual}}

## Done when
{{done}}
```

**Built-in starters:** `bug` (above), `feature` (problem, proposal, alternatives) and `task` (goal and notes). `issues init` copies the chosen ones into the repo, where the team owns them. Every built-in has a required Done when section, and template lint requires one in custom templates too, because closing as done is judged against it.

**Done when is to issues what Scope is to adr.** It states in words what finished means. When an agent closes an issue, it must say in the `reason` how each condition was met; when the conditions change, that is a description edit, visible in the diff and reviewed like any other.

**Maintenance commands**

- `issues template new spike --from task` forks a starter.
- `issues template lint` checks template syntax, and checks every open issue against its template version: required sections present and non-empty, guidance text removed.
- A template version bump applies to new issues only. `issues template migrate 42` re-renders one issue onto the latest version, mapping sections by id and leaving unmapped content under a Notes heading for a human to sort.

**Why section schemas matter for agents:** `issues_templates` returns the sections and guidance, the agent fills a `sections` map, and the tool renders the markdown. `issues_update` replaces sections by id, so an agent can rewrite Steps to reproduce without touching the rest of the description.

## Git hook helpers

Hooks give fast local feedback and keep commits connected to issues; CI remains the real guard, because hooks can be skipped with `--no-verify`.

`issues hooks install` writes thin shims into `.git/hooks` that call the CLI. Teams that already use a hook manager run `issues hooks print --manager lefthook` (also `husky` and `pre-commit`) to get a snippet to paste into their existing config instead. The shims are ledger's: one shim per hook runs every installed ark tool, so a repository using adr and issues has one pre-commit hook, not two.

| Hook | Runs | Purpose |
| --- | --- | --- |
| `pre-commit` | `issues hooks run pre-commit`: rename following, the index check (or regenerate-and-stage with `[hooks] index = "stage"`), then `issues verify --staged` | Catches bad events, broken links and stale index before the commit exists |
| `commit-msg` | `issues hooks trailers` | Adds one `Issue:` and `Issue-Event:` pair per issue and event type when event files are staged, unless the message has them already or a merge is in progress, and `Issue:` for the current issue set by `issues work`, on any commit, adr's included |
| `pre-push` | `issues verify --base @{upstream} --ref HEAD --fetch-sources` | Full invariant check against what the remote has, with references into other repositories checked at their fetched refs |
| `post-merge` | `issues list --since ORIG_HEAD` | Prints issues newly closed, reopened or assigned to you after a pull |

`--staged` checks only issues touched by staged files, keeping `pre-commit` well under a second on large issue logs. When the staged changes touch an input outside the log that every check reads (`issues.toml`, `<root>/issues.toml`, `<root>/templates/`, the decision log or its `adr.toml`), it checks every issue instead and says so in a note: a staged `adr reject` or a staged `mcp_can_close = false` can break issues no staged file touches.

When staged changes rename files covered by a scope glob, `pre-commit` also runs `issues scope --follow-renames` and stages the resulting `scoped` events in the same commit, as adr does. The config key `[hooks] scope_follow_renames` sets this to `stage` (default), `warn` or `off`.

**Closing from commit messages, deliberately not.** Many trackers close issues from `Fixes #42` in a commit message. issues does not, because that would make state depend on commit metadata, which squash merges rewrite. `issues close` in the same pull request is the equivalent, and `commit-msg` warns when a message says `fixes` or `closes` for an issue with no staged `closed` event.

## CI checks

CI runs `issues verify --base origin/main` on every pull request, and the build fails on any error. Warnings become annotations without failing the build, unless configured to. ark's shared GitHub Action runs it together with every other ark tool configured in the repository; other CI systems use the exit code and `--json` output.

| Check | Fails when |
| --- | --- |
| Append-only events | Any existing event file is modified, renamed or deleted |
| Schema | An event does not validate against its JSON Schema version |
| State machine | Replaying events produces an illegal transition, or an issue's first event is not `opened` |
| References | A `linked.to`, `closed.of` or `parent` points to a missing issue (or one without a valid `opened`), a qualified reference names an unknown source, a relation targets the wrong kind, a duplicate points at another duplicate, an issue has two parents, or a `part-of` or `depends-on` graph contains a cycle |
| Identity | Two issues share a canonical id, or two events share an id |
| Orphans | An issue file has no `opened` event, or events exist for an issue with no file |
| Template lint | An open issue is missing required sections or still contains guidance text |
| Labels | A `labeled` set holds two labels with the same exclusive prefix |
| Index freshness | `index.md` differs from what `issues index` would generate |
| Actor policy | A `closed` event has `actor.kind: agent` while `mcp_can_close` is off, or `close_requires_human` is on; an agent's `closed` event has no `reason`. Every applied `closed` event is checked, so turning a key on reports earlier agent closes in a full `verify` |
| Scope globs | A scope glob of an in-progress issue matches no tracked file, or a stored glob is invalid. An open issue's globs may name code that doesn't exist yet: the work is planned, so verify reports them only once the issue is started |
| Code anchors | An `issue:` comment anchor points to a missing issue |
| Stale anchors | An `issue:` anchor points to a closed issue; a warning, so leftover TODOs surface in review |
| Closed with open work | A closed issue (any resolution) still has open children, or an issue closed as done still has open dependencies; a warning |
| Implements | An `implements` link points to an adr decision that is not accepted; a warning |
| Other repositories | A reference into a cached `[[sources]]` log names a missing issue or decision (`issue/reference-missing`); a referenced source that isn't cached is a `sources/not-fetched` warning |

The append-only, schema, state machine, identity, orphan, template, index, scope and anchor checks are ledger's and behave identically in adr; the rest are the issue kind's invariants. Because events are separate files, squash merges and rebases are safe: history rewriting cannot lose state, since the state is in the tree rather than in commit metadata.

**Repository requirements.** These guarantees hold only with the following settings on the main branch, the same as adr's:

- **Force pushes are disabled**, so commits stay immutable and display numbers stay stable. Git's content addressing is the tamper evidence; events carry no signatures of their own.
- **Branches must be up to date before merging**, or merges go through a merge queue, so `verify` runs on the actual merge result. Two branches that are each valid can combine into an invalid history, for example one closing an issue and another closing it again. Because they touch different files, git merges them without a conflict, and only a check on the merged result catches it.
- **State changes happen inside the pull request.** The `closed` event is reviewed together with the fix; no bot writes events at merge time.

## Testing

The state machine, the relation graph and the verifier are pure functions, so most of the test suite is property-based, as in adr. The generators and temporary-repository fixtures come from ledger's test harness; issues adds generators for its own events and relations. fast-check generates thousands of random histories per run, and every property must hold for all of them.

| Property group | Generated input | Must hold |
| --- | --- | --- |
| Lifecycle model | Random command sequences: open, start, stop, close, reopen, assign, label, comment, link, unlink, scope | After every step the projection matches a small reference model; illegal commands are rejected by both and leave state unchanged |
| Invariants | Any legal history | Exactly one `opened` per issue; duplicates point at canonical issues; `part-of` and `depends-on` are acyclic; `canonical` terminates; appending events never renumbers an issue |
| Derived relations | Random dependency graphs with random closes | `blocked` is true exactly when an open dependency exists; `blocks` is the exact inverse of `depends-on`; the ready list holds no blocked, assigned or parent issue |
| Order independence | A legal history with event files read in random order | Identical projection |
| Merge safety | A shared history forked into two branches, each valid, then combined | `verify` reports a finding exactly when the branches conflict |
| Verifier mutation | A valid history plus one tampering: modified or deleted event, duplicate id, dangling link, cycle, dangling anchor | `verify` flags every mutation and never flags the original |
| Round trips | Events, template sections, file renames | Events and sections survive serialize and parse unchanged; after renames, a file is covered by the new globs exactly when its original path was covered |
| Time travel | A repository with history | The state as of a ref equals the fold of the events in that ref's tree |

Most properties run against the pure core at milliseconds per case. A smaller set, mainly merge safety and time travel, runs against real temporary git repositories with fewer iterations. Property tests are built with the core in phase 1 of the roadmap, not added afterwards.

## Agent skill (SKILL.md)

The MCP server gives agents the capability; the skill gives them the judgment of when to use it. `issues init --skill` writes it to `.claude/skills/issues/SKILL.md`, or to `<dir>/SKILL.md` with `--skill-dir <dir>` (for example `.kiro/skills/issues`), and a one-line pointer goes into `AGENTS.md` for tools that do not load skills; it never overwrites an existing SKILL.md.

```markdown
---
name: issues
description: Use when starting, continuing or finishing a piece of work, when asked what to work on next, when you find a bug or follow-up you will not fix now, and whenever asked to record, look up or close an issue.
---

# Issues

Issues in this repo are managed by issues. Issue files do not show their
own state, so never judge from the raw files whether an issue is open.
Read issues with issues_get or issues://issue/{id}.

## Before starting work

1. If the user named an issue, call issues_get. If it is a DUPLICATE,
   work on the canonical issue instead. If it is blocked, tell the user
   which issues block it before starting.
2. If the user asked what to do next, call issues_ready and propose one.
3. Call issues_for_path for the files you will touch, so you know about
   open work there.
4. Call issues_start when you begin. If it notes scope globs that match
   no tracked file, commit those files with it or fix the scope with
   issues_scope.

## While working

- Record progress, findings and decisions as issues_comment, briefly.
- When the understanding of the work changes, update the description
  with issues_update. Keep Done when accurate.
- When you find a bug or follow-up you will not fix now, search with
  issues_search (include_closed: true) first; if an issue exists,
  comment on it instead. Otherwise open an issue with issues_open
  instead of leaving a TODO. If code should point at it, add an
  // issue:<id> anchor.
- If the work implements an architectural decision, link it with
  rel implements to adr:<id>.

## Finishing work

1. Check every condition under Done when. If one is not met, say so and
   do not close.
2. Close with issues_close, resolution done, and a reason that says how
   each condition was met. The closed event belongs in the same change
   as the fix. If issues_close isn't available, or refuses with
   issue/agent-closed, the repository keeps closing to people: tell the
   user the issue is ready to close and how each condition was met.
3. If you stop without finishing, call issues_stop and comment what is
   left.

## Never

- Edit files under docs/issues/events/ or index.md by hand.
- Close an issue you did not work on, or close as wontfix or obsolete,
  without the user agreeing.
- Reopen issues. Comment why it should be reopened and tell the user.

## Without the MCP server

Use the CLI with --json: issues ready, issues search, issues for,
issues show, issues new --no-edit --section <id>=<text>, issues start,
issues comment, issues close. Set ARK_AGENT=<your name> and
ARK_ON_BEHALF_OF=<the user's email> so your writes are attributed and
the close policy applies to you.
```

## Implementation notes, roadmap and open questions

**Implementation notes**

- TypeScript, in the ark monorepo as `packages/issues`, published on npm as @nikovirtala/issues with the binary `issues`, so `npx @nikovirtala/issues` works without a global install. Versioned independently of the other ark packages.
- Depends on `@nikovirtala/ledger` for everything below the domain, and on `@nikovirtala/adr/kind` to read decision logs.
- Exports its own kind as `@nikovirtala/issues/kind`, with no CLI or MCP dependencies, so other tools can fold issue logs the same way.
- The issue kind stays pure: `reduce`, `invariants`, `relate` and `project` take data and return data; all I/O, including git, goes through ledger.
- Relations live in the issues package until adr uses the same shapes; then they move into ledger and the copies are deleted. Set events come from ledger's Scope layer.

**Roadmap**

issues is step 4 of ark's extraction plan. It starts once ledger's mechanical core exists and adr has proven the fold engine.

1. Core (issues 0.1.0): the issue kind (events, state machine, invariants and soft rules, relations with derived `blocks`, `blocked`, `children` and `canonical`, ready work, `?` numbers, mutable descriptions), `implements` links checked against the local decision log, state headers in `show`, and the commands `init`, `new`, `edit`, `start`, `stop`, `close`, `reopen`, `assign`, `label`, `comment`, `link`, `unlink`, `scope`, `for`, `ready`, `work`, `list`, `show` and `verify`.
2. Guardrails: hooks (including the commit-msg trailers and the `fixes` warning), the generated index, checks over code (scope globs, anchors, stale anchors), and checks of references into other repositories for adr and issues alike.
3. Agents: the MCP server (17 tools, three resources, two prompts), SKILL.md and `init --skill`, response state headers, `search`.
4. Adoption: template management, and one-way import from GitHub Issues through `gh`, synthesizing `opened`, `commented`, `labeled` and `closed` events with their original timestamps and authors.
5. Later: an optional live board published as an artifact page that reloads on every new event, as decided in the ark design. Not part of the first version.

**Open questions**

- [x] **Shared core with adr.** Decided in the ark design: both tools are built on ledger, a shared core library in the ark monorepo, with one event envelope for every kind.
- [x] **Display number prefix.** Forges auto-link `#42` to their own issues and pull requests in commit messages and markdown, which would point at the wrong thing. A distinct prefix avoids that. Decided: `?42`, which neither GitHub nor GitLab uses and which reads naturally for an open item. The catch: ? is a shell wildcard and starts a URL query, which matters little because the prefix is for prose, markdown and commit messages only.
- [x] **Concurrent label changes.** Decided: set events, where the later of two parallel changes wins, are enough for the first version. Deltas that merge for `labeled` and `assigned` are added later only if a real use case shows up.
- [x] **Edits after close.** Decided: descriptions stay editable after close, with git as the history. Closed issues can be reopened, so freezing the description at close would only get in the way of the work that follows.
- [x] **External waits.** Decided: no waiting state in the first version. Blocked is only derived from other issues, and a label such as `waiting:vendor` covers work blocked outside the tracker. A state is added later if labels prove not enough.
- [x] **Default location.** `issues/` at the repository root, `.issues/`, or `docs/issues/` next to `docs/adr/`. Decided: docs/issues/ by default, next to docs/adr/, and configurable with root in issues.toml.
- [x] **Agent closing default.** `mcp_can_close = true` stays the default. Decided: agents close issues once they judge their work done against Done when. A closed issue can be reopened, so closing is cheap to undo, unlike accepting an ADR, where adr's agents-propose-humans-decide stance remains.
