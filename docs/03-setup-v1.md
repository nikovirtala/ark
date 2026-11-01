# Agent setup: Design Doc

Oct 31, 2026 · drafted by Claude for @Niko Virtala

## Context and scope

ark's tools keep a project's decisions and work in its repository, usable the same way by people and agents. Agents reach them through three things the tools ship: MCP servers (`adr mcp`, `issues mcp`), skills that tell an agent when to use them, and hooks that bring records to the point of work. Git hooks and CI check that nothing invalid lands.

Setting all of that up is today four separate, opt-in steps:

| Piece | How it is set up today | Where it lives |
| --- | --- | --- |
| The log | `<tool> init` | the repository |
| The skill | `<tool> init --skill` | the repository |
| Git hooks | `<tool> hooks install` | `.git/hooks`, one clone only |
| MCP server | a snippet the README asks you to paste into the client's config | wherever the person puts it |
| Harness hooks and permission rules | nothing | nowhere |

ark itself shows the result. Its decision and issue logs were created on 22–23 October; the MCP servers arrived on the 26th. Nothing brought the existing setup up to date, nothing reported that it was incomplete, and agents kept working through the workspace CLI, as `AGENTS.md` says, so the gap went unnoticed. ark's own agents work on ark without ark. If it happened here, it will happen in every repository that adopts the tools.

This design covers what a complete setup is, how the tools write it, keep it current and report gaps, and which versions ark itself runs. It does not cover the content of the skills or what the hooks show beyond naming the commands they run.

## Why a design doc

Three things are open together and depend on each other: what init should write for each harness, how a rerun can update files people may have edited, and which versions a repository that develops the tools should run on itself. Each could be decided alone, but the answers only hold if they fit.

## Goals and non-goals

**Goals**

- A repository that runs `init` once has the whole integration: log, skills, MCP config, harness hooks, permission rules and git hooks.
- Rerunning `init` is the upgrade: it adds what a new release brings and updates what it owns.
- A gap in the setup is reported, at the start of every agent session and in CI.
- Per-clone state, the git hooks, installs itself.
- ark runs its own tools from the previous release and updates them through reviewed pull requests.

**Non-goals**

- Supporting every agent harness. Claude Code and Kiro first; others get the skill and `AGENTS.md`.
- Configuring a person's machine. Everything here is project-level and committed, except what names the person.
- Enforcing behaviour inside the agent. The setup makes the right path the default and the wrong paths unavailable; scenario evaluations, a separate piece of work, measure how agents actually behave.

## Overview

ledger's shared init (`initToolLog`, from ?43), used by every ark tool, is extended to write the complete setup for each harness it detects and marks what it owns. Running it again updates what it owns and leaves everything else alone. A `doctor` command, also shared, checks the same pieces and reports what is missing or out of date; the session-start hook runs it and installs missing git hooks. ark itself pins exact published versions in its setup, and its release workflow bumps the pins and reruns `init` in a pull request: the bootstrapping pattern self-hosting compilers use.

## Detailed design

### What a complete setup is

| Piece | Claude Code | Kiro | Written by |
| --- | --- | --- | --- |
| MCP servers | `.mcp.json` | `.kiro/settings/mcp.json` | `init` |
| Skills | `.claude/skills/<tool>/SKILL.md` | `.kiro/skills/<tool>/SKILL.md` | `init` |
| Pointer for other agents | `AGENTS.md` line | `AGENTS.md` line | `init` |
| Session-start hook | `.claude/settings.json` | Kiro agent hook | `init` |
| Before-edit hook | `.claude/settings.json` | Kiro agent hook | `init` |
| Permission rules | `.claude/settings.json` | Kiro's equivalent, where it has one | `init` |
| Git hooks | per clone | per clone | the `prepare` script and the session-start hook |

The exact file formats of each harness change over time; the implementation follows each harness's current documentation and keeps the formats in one module per harness.

**MCP servers** run the tool with `npx -y @nikovirtala/<tool>@<exact version> mcp`, with `ARK_AGENT` naming the harness. `ARK_ON_BEHALF_OF` names a person, so it is never committed: the config passes it through from each developer's environment, and the tool notes when it is unset (ADR-0007).

**The session-start hook** runs `doctor --fix-clone` (below), then `<tool> list --since <last seen>` for each installed tool and `issues ready`, and adds the output to the agent's context. **The before-edit hook** runs `adr for <path>` and `issues for <path>` the first time a session edits a file, and adds the result. Both are small commands the tools provide (`<tool> hooks agent session-start` and `… before-edit`), so the harness configuration only names a command and the logic stays in the tools.

**Permission rules** deny agents direct edits to `docs/*/events/**`, `docs/*/index.md` and decision bodies, so records change only through the tools, which validate and attribute every write.

### Starting point: ledger's shared init

?43 (pull request #86) moved init's steps into ledger: `initToolLog` in `packages/ledger/src/surfaces/tool-init.ts` takes a `ToolInitSpec` (the tool's config, templates, skill text, AGENTS.md pointer and index render) and `ToolInitOptions`. It already does several things this design needs:

- It never overwrites a file; it reports what it left as `kept`.
- It notes a SKILL.md that differs from the tool's version, so the tool already knows when a skill is out of date; it just doesn't act on it.
- It removes what it wrote when a step fails (?56 dropped an unreachable AGENTS.md restore: `writeNewFile` and the `replaceFile` guard never leave AGENTS.md half-written, so the rollback only removes the files init wrote).
- It adds the AGENTS.md pointer only when no line already names the skill.
- It commits only what it wrote.

What it lacks is the rest of the setup table, more than one skill directory (`skill` takes one `dir`), and a way to update what it wrote earlier. The hook steps in `hook-steps.ts` and `tool-hooks.ts` are shared in the same pull request, so the `prepare` script and the session-start hook's git-hook install call the same code as `<tool> hooks install`. The design below extends these functions; it adds no second init.

### init: complete by default, safe to rerun

`init` detects the harnesses a repository uses (their config directories, or flags) and writes every piece for each. Flags opt out of a piece (`--no-mcp`, `--no-hooks`, `--harness claude`), never in.

**Ownership.** `init` owns what it wrote, and only that. In a JSON config it owns the entries under its own server or hook names; in a markdown file, the lines it added; a skill file whole. It records a hash of what it wrote for each owned piece in `<git common dir>/ark/setup.json`, which is per clone, and also in a committed `ark-setup.lock` beside the configs, so every clone knows what the last `init` wrote.

**Rerun.** For each piece: if it is missing, write it; if it matches what `init` last wrote, replace it with the new version (today's `kept` case, now updated instead of skipped); if someone changed it, leave it in `kept` and print a note naming the file and the command that would overwrite it (`init --force <piece>`). A rerun with nothing to do changes nothing.

**Git hooks** cannot be committed. `init` adds `"prepare": "<tool> hooks install --quiet"` to `package.json` in JavaScript repositories, so installing dependencies installs the hooks; in any repository, the session-start hook installs them if they are missing (below).

### doctor

`doctor` checks every piece in the table above against what the installed tool would write, and reports each gap with the command that fixes it: missing, outdated (written by an older version), changed by someone, or pointing at a version other than the one installed. It exits 1 when something is missing. `--fix-clone` also installs what is per clone, the git hooks, because that can never be wrong to install. It runs in the session-start hook and in CI as a warning.

Both tools expose it as `<tool> doctor [--fix-clone]`, sharing one implementation in ledger that reuses the setup table (the same pieces `init` writes) and the ownership hashes in `ark-setup.lock`. A missing piece is the only gap that makes the exit code 1 (R5); an outdated, changed or wrong-version piece is reported with its fixing command but does not fail. `--fix-clone` reuses the git-hook install step (`hooks install`), so a session that starts without the clone's hooks installs them, or says why it cannot when another tool owns the hooks path (R6).

**In ark's CI, doctor is a warning, not a failure (answers Q3 below).** ark's committed setup still pins the published tools, which do not have `doctor` yet (see "What the hand setup settled"); CI therefore runs `doctor` from the workspace build and surfaces its output without failing the job (`doctor` exits 1 on a missing piece, so the step swallows that exit). R9 already fails the build when ark's committed setup drifts from what `init` writes, so making `doctor` a hard failure too would be redundant and would couple every unrelated change to the state of a clone's per-clone pieces. The session-start hook is where `doctor --fix-clone` earns its keep for a working clone.

**ark's committed session-start scripts are unchanged by this slice.** The general `init` template names `doctor --fix-clone` as the session-start hook's first step, but ark's own committed scripts keep the `hooks install` stand-in until a release ships a tool with `doctor` and the pins bump to it (ADR-0017; "What the hand setup settled"). Changing ark's committed scripts now would make `init` write a command the pinned published tools cannot run. So R9 stays green against the stand-in scripts, and ark adopts the `doctor --fix-clone` form when the pins catch up (the pin-bump slice).

### Which versions a repository runs: bootstrapping

A repository that only uses the tools pins exact versions in its configs and updates them by rerunning `init` after upgrading.

ark, which develops the tools, follows the proposed decision to run its own agent tooling from the previous release (`adr:jgdhvxtq`):

1. **Stage 0 runs the work.** ark's configs pin the last published versions, so a broken workspace build never takes its agents' tools down.
2. **Stage 1 proves the change.** CI builds the workspace and runs it against ark's own logs before a release.
3. **The release is the self-update.** After publishing, the release workflow bumps the pins and reruns `init` in a pull request; merging it is when ark starts using the new version on itself.

## Requirements

- **R1** `init` MUST write every piece in the setup table for each detected harness unless a flag opts that piece out.
- **R2** Rerunning `init` MUST NOT change a piece someone else edited; it MUST name each such piece and the command that would overwrite it.
- **R3** Rerunning `init` with nothing to update MUST leave the working tree unchanged.
- **R4** MCP configs MUST pin an exact version, and MUST NOT contain `ARK_ON_BEHALF_OF`'s value.
- **R5** `doctor` MUST exit 1 when any piece is missing, and print the fixing command for each gap.
- **R6** The session-start hook MUST install missing git hooks in the clone, or say why it cannot.
- **R7** The before-edit hook SHOULD report each file once per session.
- **R8** ark's configs MUST pin published versions, never the workspace build.
- **R9** Running the shared `init` on ark MUST produce ark's committed setup with no diff.

## Worked examples

### EX-fresh-clone: a new contributor's first session

Given ark's committed setup and a fresh clone:

1. `pnpm install` runs `prepare`, which installs the git hooks.
2. The person opens Claude Code. It reads `.mcp.json` and starts `adr` and `issues` at the pinned versions.
3. The session-start hook runs `doctor --fix-clone` (nothing to fix), then lists ready issues and recent decisions.
4. The agent's first edit to `packages/ledger/src/git/git.ts` triggers the before-edit hook, which shows ADR-0002 and the open issues scoped to that file.

Expected: no manual setup step, and the agent has seen the governing decision before its first edit.

### EX-rerun-after-upgrade: a release adds a hook

Given a repository set up by version 0.6, where someone added their own server to `.mcp.json`, and the tool upgraded to 0.7, which adds a before-edit hook:

1. `adr init` finds its `.mcp.json` entry unchanged since 0.6 and updates its pin to 0.7.
2. It leaves the other server in `.mcp.json` alone; it never owned it.
3. It adds the before-edit hook, which is missing.

Expected: a diff touching only the pin and the new hook, and no note, because nothing it owned was edited.

## Alternatives considered

- **Keep setup opt-in and document it better.** Cheapest, and what exists. It is the reason ark itself ended up without the integration; documentation is a thing people must remember.
- **A separate `ark setup` command.** One command for every tool is appealing, but it needs a package that knows every tool, which ark's design rules out apart from the read-only context tool. A shared `init` in ledger gives the same result with each tool installing its own pieces.
- **Write the setup once and never touch it again.** Avoids the ownership problem, but every release that adds a capability would need a manual migration in every repository.
- **Run the workspace build in ark's own config.** Dogfoods every change at once, but a broken build or a half-finished change takes the agents' tools down mid-task. Rejected in favour of bootstrapping.

## Cross-cutting concerns

- **Security.** `npx -y` downloads and runs a package; pinning an exact version limits it to a reviewed release. Permission rules reduce what an agent can change directly. No personal identity or credential is committed.
- **Privacy.** `ARK_ON_BEHALF_OF` stays in each developer's environment.
- **Observability.** `doctor` makes the setup's state visible; agent writes stay attributed (ADR-0007).
- **Agent use.** The setup is what makes the skills' instructions true by default: the MCP servers they name exist, and the records they say to read arrive at the edit.

## What the hand setup settled

?58 wrote ark's setup by hand against the pinned published tools (adr 0.5.10, issues 0.5.6), ahead of `init` writing it. Three things the table above assumes are not true of those pinned versions, and the hand setup records the gap rather than inventing commands that cannot run:

- **No `doctor` and no `<tool> hooks agent …` subcommands yet.** The pinned CLIs expose `hooks install | uninstall | print | run pre-commit | trailers`, with no `hooks agent session-start` / `… before-edit`, and no `doctor`. So the harness hooks cannot "name a command and keep the logic in the tools" yet. The hand setup keeps the logic in small committed scripts (`.claude/hooks/*.sh`, `.kiro/hooks/*.sh`) that call the commands the pinned versions do have: `hooks install` in place of `doctor --fix-clone`, then `adr list --since <rev>` / `issues list --since <rev>` and `issues ready` for session start, and `adr for <path>` / `issues for <path>` for before-edit. When `doctor` and the `hooks agent` subcommands ship (later slices, and `doctor` in `ram953kt`), `init` replaces these scripts with the one-line command form the table describes, and R9 is checked against that version's output, not this one. `doctor` is now implemented in the workspace (`ram953kt`), but ark's own setup keeps the stand-in scripts until a published release carries `doctor` and ark's pins bump to it: ark pins the published tools, never the workspace build (R8, ADR-0017). Until then CI runs `doctor` from the workspace build as a warning (see "doctor").
- **`prepare` cannot `npx` the pinned tools in this repository.** The design's `"prepare": "<tool> hooks install --quiet"` assumes `npx @nikovirtala/<tool>@<version>` runs a published release. In ark that is false: ark's root `devDependencies` pin `@nikovirtala/adr` and `@nikovirtala/issues` as `workspace:*`, so pnpm symlinks those names into `node_modules` and `npx @nikovirtala/adr@0.5.10 hooks install` resolves to the local workspace copy, ignoring the pin. On a fresh or CI checkout that copy's `dist/` is not built when `prepare` runs during `pnpm install`, so it crashed with `Cannot find module .../packages/adr/dist/cli.js` and failed the install — and running `npx` of the workspace build in ark's own config would violate R8 even once built. So the hand setup writes `"prepare": "node scripts/git-hooks.mjs install --if-built"`: the same build-safe installer contributors run as `pnpm git-hooks install`, which installs ark's hooks (both tools plus commitlint, ADR-0011) when the workspace is built and, with `--if-built`, skips with a message and exit 0 on an unbuilt checkout so `pnpm install` always succeeds. When a published release carries the pieces the table assumes, `init` replaces this with the `<tool> hooks install --quiet` form and R9 is checked against that version's output, not this one.
- **No once-per-session before-edit dedup (R7 not met by the stand-in).** R7 says the before-edit hook SHOULD report each file only the first time a session edits it, which the `<tool> hooks agent before-edit` form would do by tracking session state. That subcommand is not in the pinned versions, so the committed stand-in `before-edit.sh` runs `adr for <path>` / `issues for <path>` on every matching edit with no seen-file tracking, and the same file reports on each edit. R7 is a SHOULD, so the stand-in is deliberate; `init` adopts the per-session form once the pinned tools carry `hooks agent before-edit`.

**Kiro has no committed permission-rule file (answers the table's "Kiro's equivalent, where it has one").** Kiro's permission rules live per-user outside the repository (`~/.kiro/settings/permissions.yaml` and `~/.kiro/workspace-roots/<hash>/permissions.yaml`); the docs state a cloned repo cannot inject permission rules. The only in-repo expression is the `permissions` field of a committed custom agent profile (`.kiro/agents/*.json`), which ark does not ship. So the deny rules (`docs/*/events/**`, `docs/*/index.md`, `docs/adr/decisions/**`) are written on the Claude side only (`.claude/settings.json` `permissions.deny`); Kiro's layer is a documented gap, not an invented file.

## Open questions

- **Q1 (answered).** Where should the record of what `init` wrote live? **A committed `ark-setup.lock` beside the configs, plus a per-clone `<git common dir>/ark/setup.json`.** The committed lock is what lets every clone know what the last `init` wrote without the per-clone file, so a fresh clone's rerun is a no-op and R2 can tell "init wrote this" from "someone changed this". The per-clone file mirrors it for state git never tracks. Managed-block markers inside each file were rejected: they would force `init` to edit inside files it does not own line-for-line (a shared `.mcp.json`, `AGENTS.md`, `package.json`), and a hash of the owned entries keeps ownership precise without touching anyone else's content. The lock records one SHA-256 per piece: for a whole-file piece the file's bytes, for a merged JSON piece only the owned entries, so another server in the same file never reads as an edit. ?59 added `ark-setup.lock` to ark's committed setup so R9's no-diff holds.
- **Q2 (answered).** Should `init` detect harnesses, or should a repository list them in a shared config? **`init` detects them by their config directories (`.claude`, `.kiro`); a repository with neither gets every harness.** Flags only opt a harness or piece *out* (`--harness claude|kiro`, `--no-mcp`, `--no-hooks`), never in (R1), so a new harness is picked up by its directory rather than a list someone must remember to edit, the same reason the setup is complete-by-default. A shared opt-in list would repeat the gap this design exists to close.
- **Q3 (answered).** Should `doctor` fail CI, or only warn, once a repository has run the new `init`? **Only warn, at least for ark.** CI already enforces the committed setup through R9 (`init` reproduces ark's committed setup with no diff) and through the decision- and issue-log `verify` steps; those fail the build. `doctor` adds visibility of per-clone and version drift that a warning surfaces without making every change hostage to it, and a repository that wants a hard gate can run `doctor` as its own required step. ark runs it from the workspace build because its pinned published tools do not have `doctor` yet (see "What the hand setup settled"). A repository on a published tool with `doctor` can tighten this to a failure later if it wants to.
- **Q4** Is this document a design for the design tool to manage once it exists, and if so, does it move into its log as the tool's first record? (For Niko.)

## Work

- 8706c0vk: configure ark's own agents with MCP servers, skills, hooks and permissions (by hand, now; implements `adr:jgdhvxtq`)
- cxas6afn: make init set up the whole agent integration, and safe to rerun (extends ?43's `initToolLog`, merged in #86)
- ram953kt: report missing or outdated agent setup with a doctor command
- t9vg1qty: bump ark's own tool pins when a release publishes (implements `adr:jgdhvxtq`)

## Sources

- [ark: Design Doc](00-ark-v1.md), [adr: Design Doc](01-adr-v1.md), [issues: Design Doc](02-issues-v1.md)
- ADR-0007 (attributing agent writes), ADR-0011 (one hook shim per hook), the proposed `adr:jgdhvxtq`
- ark's history: the logs were created on 2026-10-22 and 2026-10-23; the MCP entry landed on 2026-10-26
