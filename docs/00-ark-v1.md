# ark: Design Doc

Oct 22, 2026 · @Niko Virtala

## Summary

ark is a monorepo of tools that keep a project's knowledge in its git repository, usable the same way by humans and agents. Its first members are [adr](01-adr-v1.md) for architecture decisions, [issues](02-issues-v1.md) for work, and artifact for published pages. adr and issues are built on ledger, a shared core library for git-backed, event-sourced records.

The name: an ark is a chest built to keep what matters safe. The word shares its root with archive.

**Problem.** adr and issues were designed separately but are the same machine underneath: subjects stored as files, an append-only event log per subject, state folded from events on read, and CI checks that the log stays valid. Built as two codebases, that machinery is written twice, drifts apart, and the tools cannot read each other's logs without reimplementing each other. issues already needs to know whether an ADR is accepted.

**Goals**

- One implementation of the event-log machinery, used by every ledger-based tool.
- One event envelope across tools, so any tool can fold any other tool's log with the same engine.
- A new ledger-based tool is mostly a definition of its domain: event types, rules and projection, not infrastructure.
- Each tool still ships as its own npm package with its own CLI and MCP server, installable alone.
- Repositories with several ark tools get one set of git hooks and one CI step, not one per tool.

**Non-goals**

- A single combined CLI. Users install `adr` or `issues`, not ark.
- A plugin system for third-party kinds. ledger's API is for tools in this repository until it has proven stable.
- Forcing artifact onto ledger. It is a server with its own storage model and shares the repository, toolchain and conventions, not the core.

## Packages

ark has four packages: two ledger-based tools, the ledger core they depend on, and artifact, which shares the repository but not the core.

&#91;embedded content: ark packages · 4 packages, 1 shared core\]

issues also imports adr's kind definition, so it can fold the decision log and check that its `implements` links point at accepted decisions. Nothing depends on artifact, and artifact depends on nothing else in ark.

## Monorepo

ark lives in one repository, `nikovirtala/ark`, with one package per tool and ledger as an internal dependency. Each package is versioned and released on its own.

```
ark/
  package.json                  # workspace root, scripts only
  pnpm-workspace.yaml
  tsconfig.base.json
  .changeset/                   # pending version bumps and changelog entries
  packages/
    ledger/                     # @nikovirtala/ledger
    adr/                        # @nikovirtala/adr, binary adr
    issues/                     # @nikovirtala/issues, binary issues
    artifact/                   # @nikovirtala/artifact, binary artifact
  docs/
    adr/                        # ark's own decisions, managed by adr
    issues/                     # ark's own work, managed by issues
  .github/workflows/
```

**Tooling**

- **pnpm workspaces** link packages locally, so a change to ledger is visible to adr and issues without publishing.
- **TypeScript project references** build packages in dependency order, and each package bundles to ESM, one entry per export path, plus its binary.
- **Vitest with fast-check** runs everywhere. ledger exports its history generators and temporary-repo fixtures from a second entry point, `@nikovirtala/ledger/testing`, next to the main `@nikovirtala/ledger`, so adr and issues test their kinds with the same harness.
- **Changesets** records which packages a change affects and how. Releasing bumps only those, writes their changelogs, and publishes them to npm with provenance from GitHub Actions.
- **CI runs per affected package**: a change in ledger tests everything that depends on it; a change in artifact tests only artifact.

**ledger is published to npm** as `@nikovirtala/ledger`, at 0.x and documented as internal until its API settles. adr and issues depend on it like any other package, so it is installed once when a project uses both.

**ark uses its own tools.** Its architecture decisions live in `docs/adr/` and its work in `docs/issues/`, managed by the tools built in the same repository. That is the most direct test of both, and it is how the monorepo's own decisions, starting with the ones in this document, get recorded once adr exists.

**Shared conventions**

Every tool, ledger-based or not, follows the same surface rules, so knowing one means knowing all:

- Config in `<tool>.toml`, either in the tool's root directory (`<root>/<tool>.toml`) or at the repository root (`<repo>/<tool>.toml`), where `[log] root` chooses the root. `--root` uses a repository-level file that names the same root, and overrides one that names another root with a warning.
- Global CLI flags `--json`, `--root` and, where history applies, `--ref`. Exit code 0 on success, 1 on failing findings or a write the log's rules forbid, 2 when the tool can't run (usage, config, environment or internal errors). Errors always fail; warnings fail only where a tool is configured to fail on them (ledger's `failOn: "warning"`).
- An agent using a CLI sets `ARK_AGENT=<agent-id>`, and `ARK_ON_BEHALF_OF=<email>` for the person it acts for. Its events are recorded with an `agent` actor on behalf of that address; without `ARK_ON_BEHALF_OF` they are recorded on behalf of the git user, and every write says so in a note. An `ARK_ON_BEHALF_OF` that isn't an email address is a config error (exit 2). Without `ARK_AGENT`, events are recorded as the git user. The git identity is git's author identity: `GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` when set, else `user.name` and `user.email`; it is never guessed.
- `--commit` writes a Conventional Commits message from `[commit] subject` in `<tool>.toml` (default `docs(<tool>): {action} {title}`, with the description starting with a lowercase letter, the title in its natural casing and the description kept to 72 characters), `--message` replaces it, and the tool's trailers are always the last paragraph.
- MCP servers start with `<tool> mcp` over stdio, and their tools are named `<tool>_<verb>`.
- Every tool that agents use ships a SKILL.md, installed with `<tool> init --skill`.

**artifact moves in.** artifact v1 already lives at `github.com/nikovirtala/artifact`. As the last step of the roadmap, it moves into `packages/artifact` with its git history preserved, and the old repository is archived with a pointer. Its npm name stays the same, and its planned AWS construct library stays a subpath export of the same package.

## ledger: the model

ledger knows five things: subjects, events, kinds, logs and findings. It knows nothing about decisions or issues; those exist only in the kinds that adr and issues define.

- A **subject** is one record: a decision, an issue. It has a canonical id, an optional body file, and an ordered list of events.
- An **event** is an immutable YAML file saying something happened to one subject. Its envelope is the same for every kind; its `data` belongs to the kind.
- A **kind** defines a type of subject: its event types, how events fold into state, which rules must hold, and what a read returns.
- A **log** is one directory of subjects of one kind in one repository, such as `docs/adr/` or `issues/`. A repository can hold logs of several kinds, and a log can reference logs in other repositories.
- A **finding** is a rule violation, an error or a warning, tied to a file and a subject.

A tool hands ledger its kind, and ledger returns the machinery to fold, verify, index and serve it:

```ts
import { defineKind } from "@nikovirtala/ledger";

export const issueKind = defineKind({
  name: "issue",                  // envelope kind; the qualified-id prefix defaults to the source name (sourceName), falling back to this
  events: { opened, started, stopped, closed, reopened, assigned, /* … */ },
  initial: "opened",              // the event every subject must start with
  reduce,                         // (state, event) => state, pure
  invariants,                     // (subject, options) => findings, per subject
  relate,                         // (log, options) => findings, across subjects
  project,                        // (subject, ctx) => the JSON both surfaces return
  body: "mutable",                // adr: { freezeOn: "accepted" }
  numbering: { on: "opened" },    // which event assigns a display number on main
});
```

Each event type is itself a small definition: its `data` schema, whether it changes state, and which states it is allowed in. The state machine is therefore data, which lets ledger draw it, test it and report illegal transitions without kind-specific code.

**Body policy** is the one place the two use cases genuinely differ in mechanism. `{ freezeOn: "accepted" }` makes ledger record a body hash on that event and verify the file never changes afterwards. `"mutable"` leaves the body to git. A kind with no body at all is also allowed.

## ledger: what the core provides

ledger provides everything below a kind's domain rules. Read bottom up, each layer uses only the ones below it.

| Layer | Provides | Used by adr and issues for |
| --- | --- | --- |
| Git | Shelling out to `git`; reading files from the working tree or any ref with `ls-tree` and `show`; staging; commits with trailers; first-parent history of main | Time travel, display numbers, `--commit`, branch views |
| Identity and files | 8-character Crockford base32 subject ids (lowercase); ULID event ids; `<timestamp>-<rand>-<type>.yaml` names; per-subject event directories; duplicate detection | Conflict-free parallel branches |
| Envelope | The shared event envelope and its JSON Schema; per-kind `data` schemas plugged in | Validation, actor attribution, forward-compatible fields |
| Fold | Loading a subject's events, ordering by `at` then `id`, replaying the kind's state machine and `reduce`; numbering on main | Every read |
| Verify | Base-to-head diffing; append-only and body-policy checks; schema, identity and transition checks; the kind's invariants; the findings model with text, `--json` and GitHub annotation output | `verify`, pre-commit, pre-push, CI |
| Sources | `[[sources]]` config; fetching pinned refs; resolving qualified ids such as `platform:k3f9q8a1` across logs and kinds | Cross-repository references, issues linking to adr |
| Scope | Glob sets with latest-wins events; set events and the `--set`/`--add`/`--remove` helper; comment-anchor scanning with a per-kind keyword; rename following; the path-to-subjects lookup | `adr for`, `issues for`, the rename hook |
| Templates | Section-schema frontmatter; rendering from a `sections` map; lint; versioning | `new`, `issues_open`, `adr_propose`, template lint |
| Index | Rendering a committed, generated markdown index from a kind's projection; freshness check | `index.md` in each log |
| Hooks | Shim installation; hook-manager snippets; one shim that runs every installed ark tool | One `pre-commit` for a repo using both tools |
| Surfaces | CLI scaffolding for the shared flags and commands; MCP server scaffolding; state headers; agent actor attribution (`ARK_AGENT`, `ARK_ON_BEHALF_OF`); commit-message templates | The common half of every command and tool |
| Testing | fast-check generators for legal histories, tampering mutations and merges; temporary git repositories | Each kind's property tests |

The split is between mechanism and meaning. ledger decides how an event is stored, ordered, validated and found. A kind decides what the event means.

**Hooks across tools.** A repository using both adr and issues gets one shim per hook, not two. Each installed tool registers itself in the shim. One run of the shim walks that registry once and runs `verify --staged` for each registered tool, each checking the staged files in its own log, and fails if any of them fails. Adding a third ledger-based tool later changes nothing in the repository's hooks.

## ledger: the shared event envelope

Every event of every kind uses one envelope, versioned separately from each kind's `data` schema, so the two can evolve independently.

```yaml
envelope: ledger/v1       # the envelope version, owned by ledger
kind: issue               # which kind's rules apply
schema: issue/v1          # the version of this kind's data schema
id: 01M5HHPQ50Q2M8K4X9ZTH6C9FA  # ULID, unique across the repository (checked per log until step 6)
subject: m4p8x2kd         # the subject's canonical id
type: closed
at: 2026-10-22T10:15:00Z
actor:
  kind: agent             # human | agent
  name: Claude Code
  email: null
  agent: claude-code
  on_behalf_of: niko@example.com
reason: Fixed by normalizing the cookie SameSite attribute.
data:
  resolution: done
```

**Used by adr and issues.** The [adr](01-adr-v1.md) and [issues](02-issues-v1.md) event schemas use this envelope as it is; only `data` and the event types are theirs.

**Rules**

- Everything a kind defines goes in `data`. The envelope fields mean the same thing for every kind, which is what lets one engine order, attribute and validate any log.
- `reason` is optional in the envelope. A kind makes it required per event type, as adr does for `rejected` and issues does for `reopened`.
- Unknown envelope fields and unknown `data` fields are preserved and ignored, so a newer tool version can add fields without breaking older readers.
- A reader that meets an envelope version it does not know stops with a finding rather than guessing.

**Reading another kind's log.** Because every log shares the envelope, a tool can fold a log of another kind by importing that kind's definition. issues imports `adrKind` from `@nikovirtala/adr/kind` and folds the decision log to check that an `implements` link points at an accepted decision. No CLI is shelled out to and no fold is reimplemented.

## Use cases: adr and issues on ledger

The two first kinds differ enough to keep ledger honest: one freezes bodies and ends in terminal states, the other keeps bodies living, reopens, and builds a relation graph. Their full designs live in their own documents; this is what each hands to ledger.

|  | adr | issues |
| --- | --- | --- |
| Subject | decision | issue |
| Body | frozen at `accepted` | mutable |
| States | proposed, accepted, rejected, withdrawn, deprecated, superseded; three terminal | open, in progress, closed; closed reopens |
| First event | `proposed` | `opened` |
| Numbered on | `accepted` landing on main | `opened` landing on main |
| Relations | supersession chain, `linked` | `depends-on`, `part-of`, duplicates, `implements` into adr |
| Set events | `scoped` | `scoped`, `assigned`, `labeled` |
| Comment anchor | `adr:<id>` | `issue:<id>` |
| Agents may | propose, note, link, scope own proposals | open, comment, start, stop, link, close when allowed |
| Own commands | `accept`, `supersede`, `for` | `ready`, `work`, `for` |

**What this tells ledger's design.** Relations are the main thing not yet in the core. adr has one chain, issues has a graph with acyclicity rules, and both need the inverse side derived (`superseded_by`, `blocks`). A generic relation layer in ledger, with declared relation types, direction and acyclicity, would serve both. It is not built up front: each tool implements its own relations first, and the shared layer is lifted into ledger in step 5.

**Set events** (`assigned`, `labeled`, `scoped`) are the other shared pattern: the event carries the whole set and the latest wins. ledger provides that once as an event helper, along with `--set`, `--add` and `--remove` on the CLI side. It lives in ledger's Scope layer since adr phase 2a, where adr's `scoped` is its first user.

## Implementation notes and roadmap

**Implementation notes**

- TypeScript, in the ark monorepo as `packages/ledger`, published on npm as `@nikovirtala/ledger` with the entry points `@nikovirtala/ledger`, `@nikovirtala/ledger/testing` and `@nikovirtala/ledger/cli` (and `@nikovirtala/ledger/mcp` once the MCP scaffolding lands). Surfaces live in their own entries so that importing a kind never loads CLI or MCP code.
- All I/O, including shelling out to `git`, goes through ledger, so the user's git config, credentials and signing setup apply unchanged.
- Wrong data in a repository becomes a finding. Caller misuse, bad config and environment failures throw typed `LedgerError` subclasses. ledger's root entry never writes to stdout or stderr; output belongs to the tools.

**Roadmap**

The roadmap is ark's extraction plan. ledger grows from its users rather than ahead of them. Mechanical layers go into the core immediately; layers that encode domain behavior move in only once both adr and issues have used them and the shapes match.

1. **Scaffold.** Create `nikovirtala/ark` with the workspace, build, test and release setup. The first 0.x release of ledger proves the pipeline.
2. **Mechanical core.** Build ledger's git, identity and files, envelope, verify findings, sources, templates, hooks and testing layers. These have no domain choices in them.
3. **adr on ledger.** Build adr as the first kind. The step lands over adr's phases 1–3. The fold engine and the state-machine-as-data definition are written in ledger with adr as their only user, and kept small. So are ledger's Scope, Index and Surfaces layers: they are mechanical, and issues needs the same shared flags and commands, so building them in adr and lifting them later would only be churn. Set events land in the Scope layer with adr phase 2a, and so do configurable Conventional Commits messages for `--commit`. The `pre-push` hook gets its default, `verify --base @{upstream}`, here too. A branch with no upstream is compared against its merge-base with `origin`'s default branch, and a repository with no remote verifies the whole log.
4. **issues on ledger.** Build issues as the second kind. Where it needs something adr does not (relations, mutable bodies), it starts in the issues package. Cross-repository reference checks at the pinned ref, and listing across sources, are built in this step too, because issues' `implements` links point into decision logs, including those in other repositories; adr's support follows from that shared design. Until then adr `link` stores a qualified target without checking it.
5. **Lift what matches.** Once both kinds work, move into ledger whatever they both implement the same way, most likely the relation layer, and delete the copies.
6. **One verify step.** Publish a reusable GitHub Action that runs `verify` for every ark tool configured in a repository and merges their findings into one set of annotations. The Action reads each tool's `--json` report, so the `ledger-findings/v1` report format gets a JSON Schema in this step. Event ids also start being checked for uniqueness across all logs in a repository. Until then they are checked per log, which is enough because a ULID has 80 random bits, so a duplicate only comes from a copied file.
7. **Move artifact in.** Bring artifact into `packages/artifact` with its git history, release it from the monorepo once, unchanged, and archive the old repository with a pointer. Until then it keeps living in its own repository.

ark starts recording its own decisions with adr once adr's phase 1 is merged and released, beginning with the decisions in this document: the monorepo, ledger as the shared core, and the shared envelope.

**Backlog**

Known gaps that no step owns yet:

- **Source-cache garbage collection.** Each source is fetched into its own bare cache repository under `<git common dir>/ark/sources/`, one per URL and ref. Old cache directories are never removed, which only costs disk space.
- **SHA-256 source repositories.** Not supported. Fetching one fails in git and surfaces as a `SourceFetchError`. This is a known limitation.

## Open questions

- [x] **Publishing ledger.** Decided: publish it to npm as `@nikovirtala/ledger` at 0.x, documented as internal until its API settles. It dedupes when adr and issues are installed together, and other tools can build on it later.
- [x] **Relation layer timing.** Decided: issues and adr build their own relations first, and the shared parts are lifted into ledger in step 5, once both work.
- [x] **Where kinds are exported from.** issues reading adr's log means importing `adrKind`. Decided: not from the full `@nikovirtala/adr` package, but from a small `@nikovirtala/adr/kind` subpath with no CLI or MCP dependencies. Every ledger-based tool exports its kind the same way.
- [x] **Versioning.** Decided: independent versions per package, so a release publishes only the packages that changed. Lockstep versions, where `adr 1.4` and `issues 1.4` always ship together, were rejected because they publish new versions of unchanged packages.
- [x] **artifact as the live view.** Decided: yes, adr and issues will offer to publish their index as an artifact page that reloads on every new event, but not in their first versions. It stays optional, so artifact never becomes a required dependency of the other two.
