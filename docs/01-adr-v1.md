# adr: Design Doc

Oct 18, 2026 · @Niko Virtala

## Summary

adr, published as the npm package @nikovirtala/adr, is a CLI and MCP server that keeps Architecture Decision Records (ADRs) in git with write-once decision bodies and an append-only event log for their lifecycle. Current status is never written into a decision; it is computed from the events every time someone, human or agent, reads it.

An Architecture Decision Record is a short document that captures one architecturally significant decision: its context, the decision itself and its consequences. Michael Nygard coined the term in [Documenting Architecture Decisions](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions) (2011), and Martin Fowler's [Architecture Decision Record](https://martinfowler.com/bliki/ArchitectureDecisionRecord.html) summarizes current practice. A project's collection of ADRs is its decision log.

adr is part of [ark](00-ark-v1.md) and built on its shared core, ledger, alongside its sibling [issues](02-issues-v1.md). adr defines the decision kind: its event types, state machine, invariants, projection, commands and MCP tools. ledger provides the rest: storage, ids, the event envelope, folding, verification, sources, scope, templates, hooks and the test harness. This document describes the decision kind and points to the ark design wherever ledger does the work.

**Problem.** Conventional ADR tooling marks a decision superseded by editing the original file, so records are not really immutable. Agents read ADR files in isolation and act on decisions that are no longer valid. Teams also disagree on templates, and sequential numbering collides across parallel branches.

**Goals**

- Decision bodies are provably immutable once accepted, verified in CI by content hash.
- Current state is derivable from the repository alone: no server, no database, works offline.
- Humans and agents use the same operations, through a CLI and an MCP server over one core library.
- Every read returns computed status and the supersession chain, so a stale decision cannot be read without the warning.
- Templates are per-repository and replaceable without touching existing records.
- Parallel branches merge without conflicts in the decision log.

**Non-goals**

- A hosted service or web UI.
- Replacing pull request review as the approval mechanism.
- General document management beyond decision records.
- Prescribing one ADR format.

## Core principles

The design treats a decision as an event and its status as a projection, with git as the only storage.

1. **Bodies freeze at acceptance.** A decision body is editable while proposed, because review needs it. The `accepted` event records the body's SHA-256, and from then on the file must never change. This is the decision kind's body policy in ledger, which records the hash and verifies it.
2. **State changes are events, never edits.** Every lifecycle change is a new, small, append-only event file. No existing decision or event file is rewritten.
3. **Git is the database.** No index service. Current state is folded from event files on read. A generated index can be committed for browsing, but it is never the source of truth.
4. **One core, two surfaces.** The CLI and the MCP server are thin adapters over the decision kind and ledger, so humans and agents get identical semantics and validation.
5. **Reads are never stale.** Any read of a decision, through either surface, carries its computed status and supersession chain.
6. **Conflict-free by construction.** One file per event with a unique name means parallel branches only ever add files, so merges never conflict in the decision log.

## Repository layout

Everything lives under one directory, configurable in `adr.toml`. Events are grouped per ADR so a fold reads one small directory.

```
docs/adr/
  adr.toml                        # config: default template, policies, index mode; or adr.toml at the repository root
  templates/
    nygard.md
    madr.md
    team-lightweight.md           # repo-specific template
  decisions/
    a7c2m9xd-use-dynamodb-for-orders.md     # displayed as ADR-0007
    k3f9q8a1-use-aurora-for-orders.md       # displayed as ADR-0012
  events/
    a7c2m9xd/
      20260312T091500Z-r4tw-proposed.yaml
      20260314T120211Z-q8a1-accepted.yaml
      20261018T070215Z-m2x7-superseded.yaml
    k3f9q8a1/
      20261016T081030Z-p4d2-proposed.yaml
      20261018T070215Z-z9c4-accepted.yaml
  index.md                        # generated projection, optional
```

Event file names are `<UTC timestamp>-<4 random chars>-<type>.yaml`, ledger's naming for every kind. They sort chronologically in a directory listing, and two branches can never produce the same name.

**Identifiers.** Ids come from ledger, the same as issues'. Each ADR gets a canonical id at creation: 8 Crockford base32 characters in lowercase (40 random bits, in the alphabet ULIDs use), such as `k3f9q8a1`. Parallel branches cannot realistically collide, so file names, events and links use only this id and nothing is ever renamed. CI still rejects duplicates.

**Display numbers** such as ADR-0012 are derived, never stored. The projection numbers ADRs in the order their `accepted` event first landed on the main branch, read with `git log --first-parent`. Main's history is append-only, so a number is stable once assigned. Proposed, rejected and withdrawn ADRs have no number and display by id. Every command and MCP tool accepts either form.

Numbering needs main's history. With `index = "committed"`, a shallow clone reads the numbers recorded in the committed `index.md`; without one, decisions display by id until you fetch the history (`git fetch --unshallow`). On a branch, these are the numbers the branch's committed acceptances will get once it merges (the index projects them): main's numbers up to the newest main commit the branch contains, then the branch's own acceptances. So they hold whether the branch was updated by a rebase or by merging main into it; a branch that is behind main gets `index/stale` on its merge result, and updating it and running `adr index` fixes that.

**Any decision log topology.** The tool prescribes no organizational structure, and sources are a ledger feature configured the same way in every ark tool. A decision log per repository, one shared org-wide decision repository, or both together all work the same way. A decision log can reference other decision logs as read-only sources, pinned to a git ref:

```toml
[[sources]]
name = "platform"
kind = "adr"
url = "git@github.com:example/platform-decisions.git"
ref = "main"
```

Inside the source repository, the log is read at the entry's `root` when it sets one, otherwise at the kind's default root; a source with neither is a configuration error.

Cross-log references use a qualified id, `platform:k3f9q8a1`, whose prefix is the `name` of the `[[sources]]` entry; `kind` only says what kind of log the source holds. Each decision log owns its ADRs' events, so `linked` can point anywhere but `superseded` can only be written in the decision log that owns the superseded ADR. Search, list and the MCP tools read the local log only for now, and say so in a note when `[[sources]]` are configured; listing and searching across sources, and CI checks of cross-log references at the pinned ref, come with ark's step 4 (see the roadmap).

A minimal config:

```toml
[log]
root = "docs/adr"  # read from <repo>/adr.toml; the default
default_template = "team-lightweight"
main_branch = "origin/main"     # the ref numbers come from; default origin/HEAD, origin/main, origin/master, main, master
index = "committed"             # committed | none

[policy]
accept_requires_human = true
mcp_can_decide = false          # agents propose, humans decide
auto_commit = false

[verify]
fail_on = "error"               # error | warning
governed_by_inactive = "warning"   # or "error"

[commit]
subject = "docs(adr): {action} {title}"  # --message overrides it

[scope]
anchor_keyword = "adr"
anchor_exclude = ["**/*.md"]    # files never searched for anchors

[hooks]
scope_follow_renames = "stage"  # stage, warn or off
index = "check"                 # check, or stage to regenerate in pre-commit
```

## Event schema

Every event is one YAML file in ledger's shared envelope, with `kind: decision` and a type-specific `data` block validated against the decision kind's JSON Schema. The envelope is defined in the ark design; only `data` and the event types belong to adr.

```yaml
envelope: ledger/v1
kind: decision
schema: decision/v1
id: 01M56X2X6RB3K9Z6Q8R5NWM2X7  # ULID, unique across the repo
subject: a7c2m9xd
type: superseded
at: 2026-10-18T07:02:15Z
actor:
  kind: human              # human | agent
  name: Niko Virtala
  email: niko@example.com
  agent: null              # e.g. MCP client name when kind = agent
  on_behalf_of: null       # the human an agent acted for
reason: Cross-entity transactions are needed for order + payment updates.
data:
  by: k3f9q8a1
```

| Type | Required `data` | Changes state | Notes |
| --- | --- | --- | --- |
| `proposed` | `title`, `template`, `template_version`; optional `supersedes: [ids]` | yes | Must be an ADR's first event |
| `accepted` | `body_sha256` | yes | Freezes the body; emitted together with `superseded` events for declared `supersedes` |
| `rejected` | none, `reason` required | yes | Terminal |
| `withdrawn` | none | yes | Author abandons a proposal; terminal |
| `deprecated` | none, `reason` required | yes | No longer applies, nothing replaces it |
| `superseded` | `by` | yes | Target must be accepted in the same tree, so in the same commit or earlier |
| `noted` | `text` | no | Clarification or follow-up; the additive alternative to editing a body |
| `linked` | `to`, `rel` (`relates-to`, `refines`, `depends-on`) | no | Non-lifecycle relations between ADRs |
| `scoped` | `set: [globs]` | no | Replaces the decision's code scope as a whole; the latest one wins. Allowed while proposed, accepted or deprecated |

Ordering within an ADR is by `at`, then `id`. The author-supplied `at` is trusted for ordering, while git history remains the audit trail of when each event actually landed. Ordering and unknown-field handling are ledger's rules, identical for every kind.

**Scope: linking decisions to code.** A decision's scope says which code it governs. Code moves, so scope cannot live in the frozen body: the `scoped` event carries the complete set of globs, and the latest event wins. Globs match repo-relative paths with `*`, `?`, `**`, `[…]` and `{a,b}`, and `*` and `**` include dot-files.

For precision, code can also point at a decision with a comment anchor above a symbol, such as `// adr:k3f9q8a1` (keyword configurable, qualified ids for other decision logs). Anchors live in the code, so they move with it through refactors and need no event. An anchor is a keyword token after a comment leader on the same line, `adr:<id>` or `adr:<source>:<id>`. Files matched by `[scope] anchor_exclude` are not searched for anchors, so docs and tests can show anchor examples.

The projection combines globs and anchors into a path-to-decisions lookup. Scope does not carry over on supersession automatically: when accepting an ADR that supersedes others, `adr accept --copy-scope` copies their scope into a `scoped` event for the new one; without the flag it asks on a terminal and otherwise tells you the `adr scope` command. Globs, anchors, the path lookup and rename following are ledger's scope layer, shared with issues; the intent-versus-mapping rule below is adr's own.

**Intent versus mapping.** Scope has two layers. The intent is part of the decision: every template has a required Scope section stating in words what the decision governs, for example "all services that write order or payment state". It is frozen with the body. The mapping is the set of globs that projects that intent onto today's code, and it lives in `scoped` events because code moves.

The rule for any scope change: if the intent sentence still reads true afterwards, it is maintenance and a `scoped` event is enough. If it no longer reads true, the decision itself has changed and needs a superseding ADR. Moving or renaming code never changes a decision; narrowing what it applies to usually does.

## State machine and invariants

An ADR has six states, three of them terminal, and only accepted decisions are in force.

&#91;embedded content: ADR lifecycle · 6 states, 3 terminal\]

A proposal ends in exactly one of accepted, rejected or withdrawn; an accepted decision may later be deprecated or superseded.

**Invariants enforced on every fold**

- The first event is `proposed`, and at most one terminal transition ever happens.
- `accepted` requires the draft to pass template lint, and records the body hash.
- `deprecated` applies only to accepted decisions; `superseded` applies to accepted or deprecated ones.
- `superseded.by` must reference an ADR accepted in the same tree, so in the same commit or earlier, and supersession chains are acyclic.
- A proposal's `supersedes` is intent only. The `superseded` events are written together with the new ADR's `accepted` event, so nothing is marked superseded by a decision not yet in force.
- `noted`, `linked` and `scoped` never change state. `noted` and `linked` are allowed in any state, including terminal ones; `scoped` only while proposed, accepted or deprecated.

The states, transitions and invariants above are the decision kind's definition, written as data. ledger replays every history against it and runs the invariants, so adr has no fold loop or transition check of its own, and the diagram and the code cannot drift apart. adr is ledger's first kind, so the fold engine is built with it.

## Projection: computing current state

Current state is ledger's fold over each ADR's events with the decision kind's reducer, recomputed on every read; at a few hundred small files this takes milliseconds.

For each ADR the fold produces:

```json
{
  "id": "a7c2m9xd",
  "number": 7,
  "title": "Use DynamoDB for orders",
  "status": "superseded",
  "superseded_by": "k3f9q8a1",
  "supersedes": [],
  "effective": "k3f9q8a1",
  "chain": ["a7c2m9xd", "k3f9q8a1"],
  "body_sha256": "9f2c…",
  "body_intact": true,
  "links": [{ "to": "f2r8b6nt", "rel": "depends-on" }],
  "applies_to": ["src/orders/**"],
  "notes": 1,
  "history": ["proposed 2026-03-12", "accepted 2026-03-14", "superseded 2026-10-18"]
}
```

`effective` follows `superseded_by` to the head of the chain, which is the decision that actually applies today. Both surfaces lead with it.

**Time travel.** Any read accepts a git ref (`--ref v4.2`). The tool then reads files with `git ls-tree` and `git show` instead of the working tree, answering "what had we decided as of release 4.2?" with no extra storage. Time travel comes from ledger's git layer and works the same in issues.

**Generated index.** With `index = "committed"`, `adr index` writes `index.md`: a header marking it generated, then accepted and proposed decisions, then superseded, deprecated, rejected and withdrawn ones, each with its number, linked title, status and date. Every adr write keeps it current, numbering decisions as they will be numbered once the commit is on main (during a merge, the merge commit), and CI checks it. It exists for people browsing on a forge; tools read it only for display numbers in a shallow clone.

**No status in decision files, ever.** The tool never writes status into a decision file, not even as managed frontmatter, because that would break immutability. This is deliberately opinionated: people opening raw files are served by the generated index, and agents by the MCP server and the skill.

## CLI surface

The CLI is the human interface and the automation entry point for hooks and CI. Every command writes files and stages them; committing is opt-in with `--commit` or `auto_commit`; the message follows `[commit] subject` and `--message` replaces it.

| Command | What it does | Files written |
| --- | --- | --- |
| `adr init [--template madr]… [--skill [--skill-dir <path>]]` | Creates the config and copies the chosen starter templates; never overwrites. `--skill` also writes SKILL.md and the AGENTS.md pointer | config, templates, SKILL.md, AGENTS.md |
| `adr new "Title" [--template X] [--supersedes 7]` | Renders a draft from the template, opens `$EDITOR` | decision file, `proposed` event |
| `adr accept k3f9q8a1 [--copy-scope]` | Lints the draft, hashes the body, accepts; supersedes anything declared; copies superseded decisions' scope with --copy-scope | `accepted` + `superseded` events |
| `adr reject k3f9q8a1 --reason "…"` | Rejects a proposal | `rejected` event (`--reason` required) |
| `adr withdraw k3f9q8a1` | Author abandons a proposal | `withdrawn` event |
| `adr deprecate 7 --reason "…"` | Retires a decision with no replacement | `deprecated` event |
| `adr supersede 7 --by 12` | Supersedes after the fact, when 12 is already accepted | `superseded` event |
| `adr note 7 "…"` | Adds a clarification without touching the body | `noted` event |
| `adr link 7 4 --rel depends-on` | Records a relation | `linked` event |
| `adr scope 7 --set\|--add\|--remove "src/orders/**"`, `--clear` | Sets which code a decision governs. With --follow-renames, writes and stages glob updates from the staged renames (never commits). A glob that matches no tracked file is written with a note; verify reports it for proposed and accepted decisions, so a `--commit` with hooks installed fails until a file matches | `scoped` event |
| `adr for src/orders/api.ts …` | Lists decisions governing files, from scope globs and code anchors, with warnings for inactive ones; with --ref, as of any past commit | none |
| `adr list [--status accepted] [--since ORIG_HEAD] [--json]` | Lists decisions with computed status; with `--since`, only those with events added since a revision | none |
| `adr show 7 [--history] [--json]` | Shows body, status, chain and history | none |
| `adr search "orders" [--all]` | Full-text search over ids, titles, bodies and notes; every word must match; active (proposed and accepted) decisions only unless `--all` | none |
| `adr index [--check] [--commit]` | Regenerates or checks `index.md`; writes keep it current | `index.md` |
| `adr verify [--base origin/main] [--staged]` | Runs every invariant check | none |
| `adr template list\|show\|new\|lint` | Template management | templates |
| `adr hooks install\|uninstall\|print\|run\|trailers` | Git hook integration through ledger's shared shims | hook shims |
| `adr mcp` | Starts the MCP server over stdio | none |

Global flags: `--ref <git-ref>` for time travel, `--json` for machine output, `--root` to override the decision log directory. These are ark's shared flags, with the same meaning and exit codes in every ark tool.

When a command creates a commit, it adds trailers such as `ADR: k3f9q8a1` and `ADR-Event: accepted`. They are redundant with the event files but make `git log --grep` and forge searches useful. The trailer carries the canonical id, because a commit on a branch is made before the decision has a number. The subject comes from `[commit] subject` (default `docs(adr): {action} {title}`), and `--message` replaces the subject and body; the trailers stay the last paragraph either way.

## MCP surface

The MCP server lets agents read decisions safely and propose new ones, but by default never decide. It runs as `adr mcp` over stdio inside the repository, sharing the core library with the CLI.

Tool results carry the same JSON documents as the CLI's `--json` (as `structuredContent`), together with a readable text that puts state headers first. Errors are `isError` results with the `ark-error/v1` document; refusals are documents with `ok: false` and the findings. Writes stage their files, and commit only with `[policy] auto_commit`. Every tool except the four decision tools is always listed; without `mcp_can_decide`, `adr_update_draft`, `adr_scope` and `adr_withdraw` act only on the agent's own proposals and refuse others with `decision/mcp-cannot-decide`. The tool list is fixed when the server starts, so changing `mcp_can_decide` needs a restart.

**Tools**

| Tool | Inputs | Returns |
| --- | --- | --- |
| `adr_search` | `query`, `include_inactive` (default false), `limit` | Matching decisions with status and a short excerpt; every word must match; active (proposed or accepted) ones only by default |
| `adr_get` | `id`, `include_history`, `ref` | Body, computed state, chain and `effective` decision |
| `adr_list` | `status` (a list of statuses), `limit` | Compact list for orientation |
| `adr_templates` | none | Available templates with their sections, required flags and guidance |
| `adr_propose` | `title`, `template`, `sections` (map of section id to markdown), `supersedes` | New ADR id, path and lint result |
| `adr_update_draft` | `id`, `sections` | Updated draft and lint result; proposed ADRs only; another person's proposal needs mcp\_can\_decide |
| `adr_note` | `id`, `text` | The `noted` event |
| `adr_link` | `id`, `to`, `rel` | The `linked` event |
| `adr_for_path` | `paths` | Decisions governing each path, with status; inactive ones carry the supersession warning |
| `adr_scope` | `id`, `set` / `add` / `remove` | The scoped event. Agents may scope their own proposals (those proposed on behalf of the same person); rescoping someone else's proposal or an accepted decision needs mcp\_can\_decide, since narrowing scope can quietly switch a decision off |
| `adr_withdraw` | `id`, `reason` | The `withdrawn` event. Agents may withdraw their own proposals (those proposed on behalf of the same person); withdrawing someone else's proposal needs mcp\_can\_decide. Only proposals can be withdrawn |
| `adr_accept`, `adr_reject`, `adr_deprecate`, `adr_supersede` | as the CLI (`adr_accept` takes `copy_scope`) | Exposed only when `mcp_can_decide = true` |

**Resources:** `adr://index` for the projected index, and `adr://decision/{id}` for one decision with its state header, where `{id}` is the id, the number or `ADR-NNNN`: `adr://decision/k3f9q8a1`, `adr://decision/12` and `adr://decision/ADR-0012` read the same decision.

**Prompt:** `adr_draft_from_discussion` turns the current conversation into a proposal, asking the agent to fill template sections and list options considered.

**Response design rules**

- Every response that includes a body leads with a state header, before the body text.
- A decision that isn't in force always carries a warning: a superseded one names the effective decision, for example `SUPERSEDED by ADR-0012 (accepted 2026-10-18). Do not apply this decision; read adr://decision/ADR-0012 instead.`; a deprecated, rejected or withdrawn one says why it doesn't apply.
- Proposals take structured `sections` rather than free markdown, so the template is enforced and lint errors come back as data the agent can fix.
- Agent-written events get `actor.kind: agent`, the MCP client name (made safe for `ARK_AGENT`'s rule) in `actor.agent`, and `ARK_ON_BEHALF_OF`, else the git user with a note, as `on_behalf_of`. Set `ARK_ON_BEHALF_OF` in the MCP client's server config: stdio clients pass only a few environment variables to the server.

## Templates and customization

Templates use ledger's template format, the same as issues': plain markdown files with a frontmatter section schema, so each team can define its own format while the tool still validates structure. Changing a template never touches existing decisions: each ADR records the template name and version it was written with.

```markdown
---
template: team-lightweight
version: 2
sections:
  - id: context
    heading: Context
    required: true
    guidance: What forces and constraints led here? Facts, not opinions.
  - id: options
    heading: Options considered
    required: false
    guidance: At least two options with one-line trade-offs.
  - id: decision
    heading: Decision
    required: true
    guidance: One or two sentences, in active voice. "We will…"
  - id: scope
    heading: Scope
    required: true
    guidance: What this decision governs, in words. Globs map it to files.
  - id: consequences
    heading: Consequences
    required: true
    guidance: What becomes easier, what becomes harder.
---
# {{title}}

## Context
{{context}}

## Options considered
{{options}}

## Decision
{{decision}}

## Scope
{{scope}}

## Consequences
{{consequences}}
```

**Built-in starters:** `nygard` (the classic context, decision, consequences), `madr` (with options and decision drivers) and `y-statement` (a single structured sentence). `adr init` copies the chosen ones into the repo, where the team owns them. Every built-in includes the required Scope section, and template lint requires one in custom templates too, because the intent-versus-mapping rule depends on it.

**Maintenance commands**

- `adr template new my-format --from madr` forks a starter.
- `adr template lint` checks template syntax, and checks every draft against its template: required sections present and non-empty, guidance text removed.
- A template version bump applies to new ADRs only. Accepted ADRs keep their original shape forever, so teams can evolve formats without migrations.

**Why section schemas matter for agents:** `adr_templates` returns the sections and guidance, the agent fills a `sections` map, and the tool renders the markdown. The agent cannot drift from the format, and the guidance doubles as prompting.

## Git hook helpers

Hooks give fast local feedback; CI remains the real guard, because hooks can be skipped with `--no-verify`.

`adr hooks install` writes thin shims into `.git/hooks` that call the CLI. Teams that already use a hook manager run `adr hooks print --manager lefthook` (also `husky` and `pre-commit`) to get a snippet to paste into their existing config instead. The shims are ledger's: one shim per hook runs every installed ark tool, so a repository using adr and issues has one pre-commit hook, not two.

| Hook | Runs | Purpose |
| --- | --- | --- |
| `pre-commit` | `adr hooks run pre-commit`: rename following, the index check (or regenerate-and-stage with `[hooks] index = "stage"`), then `adr verify --staged` | Catches body edits, bad events and stale index before the commit exists |
| `commit-msg` | `adr hooks trailers` | Adds `ADR:` and `ADR-Event:` trailers when event files are staged, unless the message has them already or a merge is in progress |
| `pre-push` | `adr verify --base @{upstream} --ref HEAD` | Full invariant check of the current branch's commits against its upstream, whichever refs the push names; without an upstream, against `origin`'s default branch, and with no remote, the whole log |
| `post-merge` | `adr list --since ORIG_HEAD` | Prints the decisions the pull brought new events for (status changes, notes, links, scope), each with the new event types, so people notice them; prints nothing when the pull didn't touch the log |

`--staged` checks only ADRs touched by staged files, keeping `pre-commit` well under a second on large decision logs.

When staged changes rename files covered by a scope glob, `pre-commit` also runs `adr scope --follow-renames` and stages the resulting `scoped` event in the same commit. The config key `[hooks] scope_follow_renames` sets this to `stage` (default), `warn` or `off`. The hook stages only into the commit's own index. For `git commit <paths>`, a rename that changes a decision's scope stops the commit and names the command to run.

## CI checks

CI runs `adr verify --base origin/main` on every pull request, and the build fails on any error; warnings fail it only where configured to. ark's shared GitHub Action runs it together with every other ark tool configured in the repository and turns findings into file annotations; other CI systems use the exit code and `--json` output.

| Check | Fails when |
| --- | --- |
| Body immutability | A decision file whose ADR is accepted (at base or in this diff) differs from base, or its body hash does not match the `accepted` event |
| Append-only events | Any existing event file is modified, renamed or deleted |
| Schema | An event does not validate against its JSON Schema version |
| State machine | Replaying events produces an illegal transition, or an ADR's first event is not `proposed` |
| References | `superseded.by`, `linked.to` or `supersedes` points to a missing ADR, a supersession target is not accepted, or the chain contains a cycle |
| Identity | Two ADRs share a canonical id, or two events share an id |
| Template lint | A proposed draft is missing required sections or still contains guidance text |
| Index freshness | `index.md` differs from what `adr index` would generate |
| Actor policy | An `accepted` event has `actor.kind: agent` while `accept_requires_human` is on |
| Scope globs | A scope glob of a proposed or accepted decision matches no tracked file, or a stored glob is invalid |
| Code anchors | An `adr:` comment anchor points to a missing ADR; qualified anchors are checked with sources (ark step 4) |
| Governed by inactive decision | The diff changes files governed by a superseded or deprecated decision; a warning by default, configurable to fail |
| Scope narrowing | A scoped event removes coverage of an accepted decision from files that still exist, so it is not a move. A warning that asks the reviewer to check the change against the decision's Scope section |

The body immutability, append-only, schema, state machine, identity, template, index, scope and anchor checks are ledger's and behave identically in issues; the rest are the decision kind's invariants. Because events are separate files, squash merges and rebases are safe: history rewriting cannot lose state, since the state is in the tree rather than in commit metadata.

**Repository requirements.** These guarantees hold only with the following settings on the main branch:

- **Force pushes are disabled**, so commits stay immutable and display numbers stay stable. Git's content addressing is the tamper evidence; events carry no signatures of their own. Signed commits are recommended for authorship, not required.
- **Branches must be up to date before merging**, or merges go through a merge queue, so `verify` runs on the actual merge result. Two branches that are each valid can combine into an invalid history, for example one rejecting and one accepting the same ADR. Because they touch different files, git merges them without a conflict, and only a check on the merged result catches it.
- **Acceptance happens inside the pull request.** The `accepted` event is reviewed together with the decision; no bot writes events at merge time.

## Testing

The state machine and the verifier are pure functions, so most of the test suite is property-based. The generators and temporary-repository fixtures come from ledger's test harness; adr adds generators for its own events. fast-check generates thousands of random histories per run, and every property must hold for all of them.

| Property group | Generated input | Must hold |
| --- | --- | --- |
| Lifecycle model | Random command sequences: propose, accept, reject, withdraw, deprecate, supersede, note, link, scope | After every step the projection matches a small reference model; illegal commands are rejected by both and leave state unchanged |
| Invariants | Any legal history | At most one terminal transition per ADR; supersession targets are accepted; chains are acyclic and `effective` terminates; accepted bodies match their hash; appending events never renumbers an ADR |
| Order independence | A legal history with event files read in random order | Identical projection |
| Merge safety | A shared history forked into two branches, each valid, then combined | `verify` reports a finding exactly when the branches conflict |
| Verifier mutation | A valid history plus one tampering: edited accepted body, modified or deleted event, wrong hash, duplicate id, dangling anchor | `verify` flags every mutation and never flags the original |
| Round trips | Events, template sections, file renames | Events and sections survive serialize and parse unchanged; after renames, every file covered before is still covered under its new path, and a file added at a covered path stays covered; a file moved into a covered directory becomes covered, and `adr scope --follow-renames` reports it |
| Time travel | A repository with history | The state as of a ref equals the fold of the events in that ref's tree |

Most properties run against the pure core at milliseconds per case. A smaller set, mainly merge safety and time travel, runs against real temporary git repositories with fewer iterations. Property tests are built with the core in phase 1 of the roadmap, not added afterwards.

## Agent skill (SKILL.md)

The MCP server gives agents the capability; the skill gives them the judgment of when to use it. `adr init --skill` writes it to `.claude/skills/adr/SKILL.md`, or to `<dir>/SKILL.md` with `--skill-dir <dir>` (for example `.kiro/skills/adr`), and a one-line pointer goes into `AGENTS.md` for tools that do not load skills; it never overwrites an existing SKILL.md.

```markdown
---
name: adr
description: Use before changing architecture, data stores, integration patterns, dependencies or cross-cutting conventions, and whenever asked to record, propose or look up an architectural decision.
---

# Architectural decisions (adr)

Decisions in this repo are managed by adr. Decision files do not
show their own status, so never judge from the raw files whether a
decision applies.

## Before changing architecture

1. Call adr_for_path for the files you will touch, and adr_search
   for the area you are about to change. adr_search returns active
   decisions only; adr_for_path also lists inactive ones, each with
   a warning.
2. If your change conflicts with an accepted decision, stop and tell
   the user which ADR it conflicts with. Do not work around it silently.
3. If the user still wants the change, propose a superseding ADR.

## Reading decisions

- Use adr_get or adr://decision/{id}, never docs/adr/decisions/*.md.
- If a response says SUPERSEDED or DEPRECATED, follow it to the
  effective decision before acting.
- If it says REJECTED or WITHDRAWN, the decision was never in force;
  do not apply it.

## Proposing decisions

1. Call adr_templates and fill every required section.
2. Use only facts from the conversation and the code. Mark unknowns
   as open questions instead of inventing them.
3. List at least two options considered when the template has that section.
4. Set supersedes when the proposal replaces an existing decision.
5. Do not accept your own proposal. Tell the user the ADR id and
   that they can review it and run: adr accept <id>
6. If the user decides against your proposal, withdraw it with
   adr_withdraw and give their reason. Don't withdraw other
   people's proposals; tell the user instead.

## Changing scope

- When you move or rename code covered by a decision, let the
  pre-commit hook update its globs (adr hooks install). For your
  own proposals, you can use adr_scope. Rescoping an accepted
  decision needs mcp_can_decide; otherwise tell the user and
  suggest adr scope <id> ….
- Before any scope change, read the decision's Scope section. If it
  would no longer read true after the change, do not rescope: tell
  the user the decision itself is changing and propose a
  superseding ADR.

## Never

- Edit an accepted decision body, any file under docs/adr/events/,
  or index.md by hand.
- Use adr_note to change the meaning of a decision. Notes clarify;
  changed decisions need a superseding ADR.

## Without the MCP server

Use the CLI with --json: adr search, adr for, adr show, adr new,
adr note. Set ARK_AGENT=<your name> and ARK_ON_BEHALF_OF=<the user's
email> so your writes are attributed.
```

## Implementation notes and roadmap

**Implementation notes**

- TypeScript, in the ark monorepo as `packages/adr`, published on npm as @nikovirtala/adr with the binary `adr`, so `npx @nikovirtala/adr` works without a global install. Versioned independently of the other ark packages.
- Depends on `@nikovirtala/ledger` for everything below the domain. All I/O, including shelling out to `git`, goes through ledger, so the user's git config, credentials and signing setup apply unchanged.
- Exports its kind as `@nikovirtala/adr/kind`, with no CLI or MCP dependencies. issues imports it to fold decision logs and check its `implements` links; adr itself depends on nothing else in ark.
- The decision kind stays pure: `reduce`, `invariants`, `relate` and `project` take data and return data, which makes the state machine trivially testable.
- The supersession chain lives in the adr package until issues' relations show the same shape; then both move into ledger's relation layer and the copies are deleted.

**Roadmap**

adr is step 3 of ark's extraction plan: the first kind built on ledger, starting once ledger's mechanical core exists.

1. Core: the decision kind (events, state machine, invariants), with ledger's fold engine built alongside it; `new` / `accept` / `supersede`, `list` / `show`, `verify`.
2. Two releases:
   - 2a. Commands and Scope: the commands `init`, `reject`, `withdraw`, `deprecate`, `note`, `link`, `scope` and `for`, `accept --copy-scope`, ledger's Scope layer with set events, Conventional Commits messages for `--commit`, and `ARK_ON_BEHALF_OF`. Phase 1's kind, fold and verify already support the events behind them.
   - 2b. Guardrails: the generated index with its freshness check and the shallow-clone number fallback; git hooks through ledger's shared shims (pre-commit, commit-msg, pre-push with the no-upstream fallback, post-merge with `list --since`); a recovery hint when `--commit` fails; and the scope-glob, anchor, governed-by-inactive and scope-narrowing checks.
3. Agents: the MCP server (15 tools, two resources, a prompt), SKILL.md and `init --skill`, response state headers, `search`.
4. Adoption: template management, and import from existing adr-tools or log4brains repos, synthesizing `proposed` and `accepted` events from their status lines without rewriting the files.
5. Later: an optional live index published as an artifact page that reloads on every new event, as decided in the ark design. Not part of the first version.

Cross-log reference checks at the pinned ref and listing across sources are not an adr phase: they are built in ark's step 4, together with issues, whose `implements` links point into decision logs, including those in other repositories. Until then `adr link` stores a qualified target unchecked and `verify` skips it.

ark's step 3 lands over phases 1–3. ark starts recording its own architecture decisions with adr once phase 1 is merged and released.
