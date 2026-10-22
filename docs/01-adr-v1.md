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
  adr.toml                        # config: default template, policies, index mode
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

**Identifiers.** Ids come from ledger, the same as issues'. Each ADR gets a canonical id at creation: 8 lowercase base32 characters (40 random bits, taken from a ULID), such as `k3f9q8a1`. Parallel branches cannot realistically collide, so file names, events and links use only this id and nothing is ever renamed. CI still rejects duplicates.

**Display numbers** such as ADR-0012 are derived, never stored. The projection numbers ADRs in the order their `accepted` event first landed on the main branch, read with `git log --first-parent`. Main's history is append-only, so a number is stable once assigned. Proposed, rejected and withdrawn ADRs have no number and display by id. Every command and MCP tool accepts either form.

Numbering needs main's history. Shallow clones fall back to the committed `index.md`, which records the assigned numbers, or fetch history on demand.

**Any decision log topology.** The tool prescribes no organizational structure, and sources are a ledger feature configured the same way in every ark tool. A decision log per repository, one shared org-wide decision repository, or both together all work the same way. A decision log can reference other decision logs as read-only sources, pinned to a git ref:

```toml
[[sources]]
name = "platform"
kind = "adr"
url = "git@github.com:example/platform-decisions.git"
ref = "main"
```

Cross-log references use a qualified id, `platform:k3f9q8a1`. Each decision log owns its ADRs' events, so `linked` can point anywhere but `superseded` can only be written in the decision log that owns the superseded ADR. Search, list and the MCP tools span all configured sources by default, and CI verifies cross-log references at the pinned ref.

A minimal config:

```toml
[log]
root = "docs/adr"
default_template = "team-lightweight"
index = "committed"             # committed | none

[policy]
accept_requires_human = true
mcp_can_decide = false          # agents propose, humans decide
auto_commit = false
```

## Event schema

Every event is one YAML file in ledger's shared envelope, with `kind: decision` and a type-specific `data` block validated against the decision kind's JSON Schema. The envelope is defined in the ark design; only `data` and the event types belong to adr.

```yaml
envelope: ledger/v1
kind: decision
schema: decision/v1
id: 01JAB3K9Z6Q8M2X7      # ULID, unique across the repo
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
| `superseded` | `by` | yes | Target must be accepted in the same or an earlier commit |
| `noted` | `text` | no | Clarification or follow-up; the additive alternative to editing a body |
| `linked` | `to`, `rel` (`relates-to`, `refines`, `depends-on`) | no | Non-lifecycle relations between ADRs |
| `scoped` | `set: [globs]` | no | Replaces the decision's code scope as a whole; the latest one wins. Allowed while proposed, accepted or deprecated |

Ordering within an ADR is by `at`, then `id`. The author-supplied `at` is trusted for ordering, while git history remains the audit trail of when each event actually landed. Ordering and unknown-field handling are ledger's rules, identical for every kind.

**Scope: linking decisions to code.** A decision's scope says which code it governs. Code moves, so scope cannot live in the frozen body: the `scoped` event carries the complete set of globs, and the latest event wins.

For precision, code can also point at a decision with a comment anchor above a symbol, such as `// adr:k3f9q8a1` (keyword configurable, qualified ids for other decision logs). Anchors live in the code, so they move with it through refactors and need no event.

The projection combines globs and anchors into a path-to-decisions lookup. Scope does not carry over on supersession automatically: when accepting an ADR that supersedes others, `adr accept` offers to copy their scope into a `scoped` event for the new one. Globs, anchors, the path lookup and rename following are ledger's scope layer, shared with issues; the intent-versus-mapping rule below is adr's own.

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
- `superseded.by` must reference an ADR accepted in the same commit or earlier, and supersession chains are acyclic.
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

**Generated index.** With `index = "committed"`, `adr index` writes `index.md`: a header marking it generated, then active decisions first and inactive ones below, each with status and links. CI checks it is current. It exists for people browsing on a forge; tools never read it.

**No status in decision files, ever.** The tool never writes status into a decision file, not even as managed frontmatter, because that would break immutability. This is deliberately opinionated: people opening raw files are served by the generated index, and agents by the MCP server and the skill.

## CLI surface

The CLI is the human interface and the automation entry point for hooks and CI. Every command writes files and stages them; committing is opt-in with `--commit` or `auto_commit`.

| Command | What it does | Files written |
| --- | --- | --- |
| `adr init [--template madr]` | Creates the layout, config and starter templates | config, templates |
| `adr new "Title" [--template X] [--supersedes 7]` | Renders a draft from the template, opens `$EDITOR` | decision file, `proposed` event |
| `adr accept 12` | Lints the draft, hashes the body, accepts; supersedes anything declared | `accepted` + `superseded` events |
| `adr reject 12 --reason "…"` | Rejects a proposal | `rejected` event |
| `adr withdraw 12` | Author abandons a proposal | `withdrawn` event |
| `adr deprecate 7 --reason "…"` | Retires a decision with no replacement | `deprecated` event |
| `adr supersede 7 --by 12` | Supersedes after the fact, when 12 is already accepted | `superseded` event |
| `adr note 7 "…"` | Adds a clarification without touching the body | `noted` event |
| `adr link 7 4 --rel depends-on` | Records a relation | `linked` event |
| `adr scope 7 --set\|--add\|--remove "src/orders/**"` | Sets which code a decision governs. With --follow-renames, proposes glob updates from git's rename detection | `scoped` event |
| `adr for src/orders/api.ts` | Lists decisions governing a file, from scope globs and code anchors; with --ref, as of any past commit | none |
| `adr list [--status accepted] [--json]` | Lists decisions with computed status | none |
| `adr show 7 [--history] [--json]` | Shows body, status, chain and history | none |
| `adr search "orders" [--all]` | Full-text search, active decisions only unless `--all` | none |
| `adr index [--check]` | Regenerates or checks `index.md` | `index.md` |
| `adr verify [--base origin/main] [--staged]` | Runs every invariant check | none |
| `adr template list\|show\|new\|lint` | Template management | templates |
| `adr hooks install\|print` | Git hook integration | hook shims |
| `adr mcp` | Starts the MCP server over stdio | none |

Global flags: `--ref <git-ref>` for time travel, `--json` for machine output, `--root` to override the decision log directory. These are ark's shared flags, with the same meaning and exit codes in every ark tool.

When a command creates a commit, it adds trailers such as `ADR: 12` and `ADR-Event: accepted`. They are redundant with the event files but make `git log --grep` and forge searches useful.

## MCP surface

The MCP server lets agents read decisions safely and propose new ones, but by default never decide. It runs as `adr mcp` over stdio inside the repository, sharing the core library with the CLI.

**Tools**

| Tool | Inputs | Returns |
| --- | --- | --- |
| `adr_search` | `query`, `include_inactive` (default false), `limit` | Matching decisions with status and a short excerpt; active ones only by default |
| `adr_get` | `id`, `include_history`, `ref` | Body, computed state, chain and `effective` decision |
| `adr_list` | `status`, `limit` | Compact list for orientation |
| `adr_templates` | none | Available templates with their sections, required flags and guidance |
| `adr_propose` | `title`, `template`, `sections` (map of section id to markdown), `supersedes` | New ADR id, path and lint result |
| `adr_update_draft` | `id`, `sections` | Updated draft and lint result; proposed ADRs only |
| `adr_note` | `id`, `text` | The `noted` event |
| `adr_link` | `id`, `to`, `rel` | The `linked` event |
| `adr_for_path` | `paths` | Decisions governing each path, with status; inactive ones carry the supersession warning |
| `adr_scope` | `id`, `set` / `add` / `remove` | The scoped event. Agents may scope their own proposals; rescoping an accepted decision needs mcp\_can\_decide, since narrowing scope can quietly switch a decision off |
| `adr_accept`, `adr_reject`, `adr_deprecate`, `adr_supersede` | as the CLI | Exposed only when `mcp_can_decide = true` |

**Resources:** `adr://index` for the projected index, and `adr://decision/{id}` for one decision with its state header.

**Prompt:** `adr_draft_from_discussion` turns the current conversation into a proposal, asking the agent to fill template sections and list options considered.

**Response design rules**

- Every response that includes a body leads with a state header, before the body text.
- A superseded or deprecated decision always carries a warning naming the effective decision, for example: `SUPERSEDED by ADR-0012 (accepted 2026-10-18). Do not apply this decision; read adr://decision/12.`
- Proposals take structured `sections` rather than free markdown, so the template is enforced and lint errors come back as data the agent can fix.
- Agent-written events get `actor.kind: agent`, the MCP client name in `actor.agent`, and the git user as `on_behalf_of`.

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
| `pre-commit` | `adr verify --staged`, then `adr index --check` or regenerate-and-stage (config) | Catches body edits, bad events and stale index before the commit exists |
| `commit-msg` | `adr hooks trailers` | Adds `ADR:` and `ADR-Event:` trailers when event files are staged |
| `pre-push` | `adr verify --base @{upstream}` | Full invariant check against what the remote has |
| `post-merge` | `adr list --since ORIG_HEAD` | Prints newly accepted or superseded decisions after a pull, so people notice them |

`--staged` checks only ADRs touched by staged files, keeping `pre-commit` well under a second on large decision logs.

When staged changes rename files covered by a scope glob, `pre-commit` also runs `adr scope --follow-renames` and stages the resulting `scoped` event in the same commit. The config key `scope_follow_renames` sets this to `stage` (default), `warn` or `off`.

## CI checks

CI runs `adr verify --base origin/main` on every pull request, and the build fails on any violation. ark's shared GitHub Action runs it together with every other ark tool configured in the repository and turns findings into file annotations; other CI systems use the exit code and `--json` output.

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
| Scope globs | A scope glob of an active decision matches no tracked file |
| Code anchors | An adr: comment anchor points to a missing ADR |
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
| Round trips | Events, template sections, file renames | Events and sections survive serialize and parse unchanged; after renames, a file is covered by the new globs exactly when its original path was covered |
| Time travel | A repository with history | The state as of a ref equals the fold of the events in that ref's tree |

Most properties run against the pure core at milliseconds per case. A smaller set, mainly merge safety and time travel, runs against real temporary git repositories with fewer iterations. Property tests are built with the core in phase 1 of the roadmap, not added afterwards.

## Agent skill (SKILL.md)

The MCP server gives agents the capability; the skill gives them the judgment of when to use it. `adr init --skill` writes it to `.claude/skills/adr/SKILL.md`, and a one-line pointer goes into `AGENTS.md` for tools that do not load skills.

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
   for the area you are about to change.
   Results are active decisions only.
2. If your change conflicts with an accepted decision, stop and tell
   the user which ADR it conflicts with. Do not work around it silently.
3. If the user still wants the change, propose a superseding ADR.

## Reading decisions

- Use adr_get or adr://decision/{id}, never docs/adr/decisions/*.md.
- If a response says SUPERSEDED or DEPRECATED, follow it to the
  effective decision before acting.

## Proposing decisions

1. Call adr_templates and fill every required section.
2. Use only facts from the conversation and the code. Mark unknowns
   as open questions instead of inventing them.
3. List at least two options considered when the template has that section.
4. Set supersedes when the proposal replaces an existing decision.
5. Do not accept your own proposal. Tell the user the ADR id and
   that they can review it and run: adr accept <id>

## Changing scope

- When you move or rename code covered by a decision, update its
  globs with adr_scope (or let the pre-commit hook do it).
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

Use the CLI with --json: adr search, adr show, adr new, adr note.
```

## Implementation notes and roadmap

**Implementation notes**

- TypeScript, in the ark monorepo as `packages/adr`, published on npm as @nikovirtala/adr with the binary `adr`, so `npx @nikovirtala/adr` works without a global install. Versioned independently of the other ark packages.
- Depends on `@nikovirtala/ledger` for everything below the domain. All I/O, including shelling out to `git`, goes through ledger, so the user's git config, credentials and signing setup apply unchanged.
- Exports its kind as `@nikovirtala/adr/kind`, with no CLI or MCP dependencies. issues imports it to fold decision logs and check its `implements` links; adr itself depends on nothing else in ark.
- The decision kind stays pure: `reduce`, `invariants` and `project` take data and return data, which makes the state machine trivially testable.
- The supersession chain lives in the adr package until issues' relations show the same shape; then both move into ledger's relation layer and the copies are deleted.

**Roadmap**

adr is step 3 of ark's extraction plan: the first kind built on ledger, starting once ledger's mechanical core exists.

1. Core: the decision kind (events, state machine, invariants), with ledger's fold engine built alongside it; `new` / `accept` / `supersede`, `list` / `show`, `verify`.
2. Guardrails: decision-specific checks in ark's shared CI action and hooks, generated index.
3. Agents: MCP server, SKILL.md, response state headers.
4. Adoption: template management, and import from existing adr-tools or log4brains repos, synthesizing `proposed` and `accepted` events from their status lines without rewriting the files.
5. Later: an optional live index published as an artifact page that reloads on every new event, as decided in the ark design. Not part of the first version.

ark records its own architecture decisions with adr from step 1 onwards.
