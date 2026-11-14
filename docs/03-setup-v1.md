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

| Piece | Claude Code | Kiro | GitHub Copilot | Written by |
| --- | --- | --- | --- | --- |
| MCP servers | `.mcp.json` | `.kiro/settings/mcp.json` | `.mcp.json` (VS Code and the CLI); the cloud agent's MCP lives in repository settings | `init` |
| Skills | `.claude/skills/<tool>/SKILL.md` | `.kiro/skills/<tool>/SKILL.md` | `.github/skills/<tool>/SKILL.md` | `init` |
| Pointer for other agents | `AGENTS.md` line | `AGENTS.md` line | `AGENTS.md` line | `init` |
| Session-start hook | `.claude/settings.json` | Kiro agent hook | `.github/hooks/<tool>.json` (`sessionStart`; the CLI and the cloud agent) | `init` |
| Before-edit hook | `.claude/settings.json` | Kiro agent hook | `.github/hooks/<tool>.json` (`preToolUse`) | `init` |
| Permission rules | `.claude/settings.json` (`Edit(/…)` deny rules) | a `PreToolUse` hook on the `write` group that blocks | a `preToolUse` hook that denies the edit | `init` |
| Git hooks | per clone | per clone | per clone | the session-start hook, and a `prepare` script where asked |

Harnesses share files. Copilot reads the same root `.mcp.json` as Claude Code, and the Copilot CLI also runs the hooks in `.claude/settings.json`. So the setup is written per file, not per harness: a file several selected harnesses read is written once, and a hook that two of them would both run is written where only one of them reads it. The cloud agent's MCP servers can't be set from a file, so `doctor` names the repository setting to add instead.

The exact file formats of each harness change over time; the implementation follows each harness's current documentation and keeps the formats in one module per harness.

**MCP servers** run the tool with `npx -y @nikovirtala/<tool>@<exact version> mcp`, with `ARK_AGENT` naming the harness. `ARK_ON_BEHALF_OF` names a person, so it is never committed: the config passes it through from each developer's environment, and the tool notes when it is unset (ADR-0007).

**The session-start hook** runs `doctor --fix-clone` (below), then `<tool> list --since <last seen>` for each installed tool and `issues ready`, and adds the output to the agent's context. **The before-edit hook** runs `adr for <path>` and `issues for <path>` the first time a session edits a file, and adds the result. Both are small commands the tools provide (`<tool> hooks agent session-start` and `… before-edit`), so the harness configuration only names a command and the logic stays in the tools.

**Permission rules** deny agents direct edits to each tool's events, its generated `index.md` and the files only the tool writes (adr's decision bodies), so records change only through the tools, which validate and attribute every write. The paths come from each tool's configured log root, not a fixed `docs/`. Claude Code gets `Edit(/<root>/…)` deny rules, anchored at the project so a session started in a subdirectory is covered. Kiro keeps permissions per person, so it gets a committed `PreToolUse` hook on the `write` group that blocks the edit and names the tool to use.

### Which harnesses: detected, then chosen

`init --setup` writes for the harnesses a repository uses, found in two ways and confirmed by the person running it.

- **Detected.** In the repository: `.claude/`, `.kiro/`, and `.github/copilot-instructions.md`, `.github/skills/` or `.github/hooks/`. On the machine, when `init` runs on one: the `claude`, `kiro-cli` and `copilot` commands, and VS Code with the Copilot extension. What the repository shows is shared; what one machine has is a suggestion, because one person's tools shouldn't decide a team's setup.
- **Chosen.** In a terminal, `init` lists the supported harnesses with the detected ones selected, and the person changes the selection. Without a terminal, as when an agent or CI runs it, `--harness claude,kiro,copilot` chooses, and without the flag the detected ones are used.
- **Recorded.** The choice is saved in the setup's config (`[setup] harnesses`), so a rerun and every other clone write for the same harnesses without asking again. Removing a harness from the list makes the next run remove the pieces `init` wrote for it, and only those.

This reverses Q2's first answer. With three harnesses, writing for all of them when none is detected fills a repository with files for tools nobody uses, and detection alone can't see an assistant the team is about to start using.

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

**ark's committed session-start scripts are unchanged by this slice.** The general `init` template names `doctor --fix-clone` as the session-start hook's first step, but ark's own committed scripts keep the `hooks install` stand-in until a release ships a tool with `doctor` and the pins bump to it (ADR-0017; "What the hand setup settled"). Changing ark's committed scripts now would make `init` write a command the pinned published tools cannot run. So R9 stays green against the stand-in scripts, and ark adopts the `doctor --fix-clone` form when the pins catch up.

The script templates in `ark-setup.ts` emit the stand-in unconditionally, so a pin bump alone does **not** switch the session-start scripts to `doctor --fix-clone`: the switch is not automatic. When a published release first carries `doctor` and the `hooks agent` subcommands, the slice that bumps ark's pins to it must also change those templates (naming `doctor --fix-clone` for versions that have it, ideally gated on the pinned version), and R9 is then checked against that output. The pin-bump mechanism (the `self-update` job) is in place; the template change rides the first release that makes it runnable.

### Which versions a repository runs: bootstrapping

A repository that only uses the tools pins exact versions in its configs and updates them by rerunning `init` after upgrading.

ark, which develops the tools, follows the proposed decision to run its own agent tooling from the previous release (`adr:jgdhvxtq`):

1. **Stage 0 runs the work.** ark's configs pin the last published versions, so a broken workspace build never takes its agents' tools down.
2. **Stage 1 proves the change.** CI builds the workspace and runs it against ark's own logs before a release.
3. **The release is the self-update.** After a release publishes new tool versions, the release workflow's `self-update` job bumps the pins and reruns `init --setup` in a pull request; merging it is when ark starts using the new version on itself. The job runs only when the publish step reports `published == 'true'`, reads the just-published versions from its `published-packages` output, and bumps them in one place: the `ARK_PINS` constant in `packages/ledger/src/surfaces/ark-setup.ts`, the single source every pin is generated from (`scripts/bump-ark-pins.mjs`). It then rebuilds and reruns `adr init --setup` and `issues init --setup`, so `.mcp.json`, `.kiro/settings/mcp.json`, the `package.json` `prepare` script, the committed hook scripts and `ark-setup.lock` all update together, and opens the change as a pull request (`peter-evans/create-pull-request`, branch `release/ark-pin-bump` into `main`). It never pushes the bump to `main`; the PR is reviewed and CI (R9 and the `verify` steps) must pass before merge. A release that carries no newer adr/issues pin (for example a ledger-only release) changes nothing and opens no PR.

### Every other repository: ark is the exception, not the template

The first implementation (?59) wrote ark's own setup into every repository. A user who ran `adr init --setup --skill` in another repository (longplay) found six problems, each one a piece of ark that should never have left it:

- the published 0.6.0 pinned 0.5.10 and 0.5.6, ark's previous-release pins;
- `package.json` got ark's `prepare` script, `node scripts/git-hooks.mjs install --if-built`, and that file exists only in ark, so `pnpm install` failed;
- the hooks ran `issues` in a repository that doesn't use it;
- the generated scripts cited ADR-0017 and this document;
- a rerun brought back a template the repository had removed;
- `AGENTS.md` sent every agent to `SKILL.md`, including agents that load skills themselves.

The cause was this design. R9, "init on ark reproduces ark's committed setup", was the only check, so ark was the only fixture, and the code that passed it was ark's setup. So the design now separates the two:

- **The setup a tool writes is generic.** It pins the version of the tool that is running, read from its own package. It writes only that tool's pieces: adr's hooks run adr, and issues adds its own when it is set up. It writes no `prepare` script unless asked; the session-start hook installs missing git hooks (R6). A rerun writes no templates. Comments in generated files explain the file and link the tool's README, not ark's records.
- **What makes ark different lives in ark's config.** ark's previous-release pins (ADR-0017), its build-safe `prepare` and anything else particular to developing the tools are settings in ark's own config that `init` reads. The release's pin bump (?61) changes that config, not the code.
- **Both are tested.** R9 keeps ark's setup reproducible; R10 and R11 check repositories that are not ark.

## Requirements

- **R1** `init` MUST write every piece in the setup table for each chosen harness (detected, then confirmed or set with `--harness`, and recorded in the config) unless a flag opts that piece out.
- **R2** Rerunning `init` MUST NOT change a piece someone else edited; it MUST name each such piece and the command that would overwrite it.
- **R3** Rerunning `init` with nothing to update MUST leave the working tree unchanged.
- **R4** MCP configs MUST pin an exact version, and MUST NOT contain `ARK_ON_BEHALF_OF`'s value.
- **R5** `doctor` MUST exit 1 when any piece is missing, and print the fixing command for each gap.
- **R6** The session-start hook MUST install missing git hooks in the clone, or say why it cannot.
- **R7** The before-edit hook SHOULD report each file once per session.
- **R8** ark's configs MUST pin published versions, never the workspace build.
- **R9** Running the shared `init` on ark MUST produce ark's committed setup with no diff, in bytes and in file mode, with everything particular to ark coming from ark's config, not from the tools' code.
- **R10** In a repository other than ark, `init --setup` MUST pin the running tool's own published version, MUST write only that tool's pieces, MUST NOT write a `prepare` script unless asked, and MUST NOT write text that refers to ark's own records. A rerun MUST NOT write templates.
- **R11** CI MUST run `init --setup` in fixture repositories that are not ark (one with only adr, a JavaScript repository without ark's scripts, and one with no `package.json`) and check that the package install still succeeds, every generated hook script runs, nothing generated names ADR-0017, this document or a tool the repository doesn't use, and a second run changes nothing.
- **R12** Every hook script `init` writes MUST be written and staged as 100755, and the harness config MUST run it as `sh <script>`. R9 MUST compare modes as well as bytes, and `doctor` MUST report a hook script that is not executable.
- **R13** An MCP write MUST succeed with `ARK_ON_BEHALF_OF` unset, empty, or still an unexpanded `${…}` placeholder, attributed to the git identity with a note that names the harness setting that fixes it.
- **R14** For each harness module, a test MUST run every configured hook command string the way the harness does (its shell, working directory and event JSON on stdin), and check the exit code, the time taken and the output format the harness delivers to the agent, and MUST start each configured MCP server with the env the harness would pass.

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

**Kiro has no committed permission-rule file, so a hook blocks (answers the table's "Kiro's equivalent, where it has one"; revised by ?80).** Kiro's permission rules live per-user outside the repository (`~/.kiro/settings/permissions.yaml` and `~/.kiro/workspace-roots/<hash>/permissions.yaml`); the docs state a cloned repo cannot inject permission rules. The only in-repo expression is the `permissions` field of a committed custom agent profile (`.kiro/agents/*.json`), which ark does not ship. A `PreToolUse` command hook can block, though (see "Harness formats" below), so `init` writes `.kiro/hooks/protect-logs.kiro.hook.json` and `protect-logs.sh`: the hook exits 2 for an edit to a protected log path, with the tool to use on stderr, which Kiro sends to the agent.

## Harness formats, checked against the documentation

The exact file formats of each harness change over time (see "What a complete setup is"). The tests that compared bytes with ark's committed files (R9) could not notice this: the 2026-11-14 audit found hook scripts that never started, hook output that never reached the agent, MCP writes that failed and deny rules that depended on the working directory, while CI passed. So each harness module (`setup-claude.ts`, `setup-kiro.ts`) declares a `HarnessRuntime`: how the harness runs a hook (shell, working directory, environment, the event JSON on stdin), how context must be emitted, how an edit is blocked, the shape of its configs and how it expands `${VAR}` in MCP env. `setup.harness.test.ts` iterates over those declarations and runs every configured hook command string the way the harness does, with fixture events from the module; `adr` and `issues` start their MCP servers the same way. A new harness is one module and its fixture events.

Checked on 2026-11-14. A later check compares these pages with the module's `HarnessRuntime`.

| Harness | Pages | What they settle |
| --- | --- | --- |
| Claude Code | [hooks reference](https://code.claude.com/docs/en/hooks), [permissions](https://code.claude.com/docs/en/permissions), [tools reference](https://code.claude.com/docs/en/tools-reference), [MCP](https://code.claude.com/docs/en/mcp) | Command hooks run in the session's current directory, through bash, with the event on stdin; `${CLAUDE_PROJECT_DIR}` is the project root. `PreToolUse` plain stdout goes to the debug log only; context arrives only as `hookSpecificOutput.additionalContext` (capped at 10,000 characters). `SessionStart` plain stdout is context; its matcher values are `startup`, `resume`, `clear`, `compact`, `fork`. The default command-hook timeout is 600 s. The edit tools are `Edit`, `Write` and `NotebookEdit` (`MultiEdit` is legacy). `Write(path)` and `NotebookEdit(path)` deny rules are accepted and never match; `Edit(path)` rules cover all three. A leading `/` anchors a rule at the project, a bare path at the current directory. `${VAR}` in `.mcp.json` stays as text when the variable is unset; `${VAR:-}` expands to empty. |
| Kiro | [hooks](https://kiro.dev/docs/hooks/), [hook actions](https://kiro.dev/docs/hooks/actions/), [hook types](https://kiro.dev/docs/hooks/types/), [CLI V3 hooks migration](https://kiro.dev/docs/cli/v3/hooks-migration/), [MCP configuration](https://kiro.dev/docs/mcp/configuration/) | A command hook runs in the project root with the event on stdin. On exit 0 its stdout is added to the agent's context, for `PreToolUse` as for the other triggers. Any other exit code sends stderr to the agent and, for `PreToolUse`, blocks the tool call; the docs don't say whether a code other than 2 differs, so the hook exits 2. The `SessionStart` event is `{"hook_event_name": "agentSpawn", "cwd", "session_id"}`; `PreToolUse` adds `tool_name` and `tool_input`. The `write` group is a matcher for every built-in file write tool (`fs_write` in CLI 2.x). The hook timeout defaults to 60 s. Kiro expands `${VAR}` in an MCP `env` only for variables the person approves under "Mcp Approved Env Vars", and documents no `:-` default. |

What no page settles, and what init does about it:

- The names of Kiro's V3 write tools and the fields of their `tool_input`. The hooks match the `write` group, and the path is read from `file_path`, `notebook_path`, `path` or `filePath`, whichever the event has. A real session confirms the field.
- What a Kiro `PreToolUse` hook that exits with a code other than 2 does. Exit 2 with stderr is the documented block for Claude Code and satisfies "any other exit code" for Kiro.
- Whether Kiro leaves an unapproved variable as the text `${VAR}`. ledger treats a value that is still a whole `${…}` placeholder as unset, whichever harness left it, so either way the write succeeds (?78).

### Choices that follow

- **Scripts run as `sh <script>`** and are written and committed as 100755. The bit can be lost by a checkout, a zip or a copy, and a hook that fails to start is silent, so the config does not depend on it; the bit is there for people who run the script by hand. `doctor` reports a script without it, and R9 compares modes.
- **One `npm exec` serves a hook's tool calls.** On a cold npm cache in the audit sandbox, `npx -y <pkg>` took 3.3 s for adr and 2.1 s for issues, 0.7 s each once cached. The session-start hook used to start five of them; it now starts one `npm exec --package=<adr> --package=<issues>` and runs every command inside it (cold 2.4 s, warm 2.3 s with its five tool calls, against 4.6 s and 4.5 s before). That is far inside Claude Code's 600 s and Kiro's 60 s, and the Kiro hook still sets `timeout: 120` so a slow network doesn't cut it off.
- **The main ref is resolved the way numbering does.** A `main_branch` set in a tool's config that resolves, else `origin/HEAD`'s target, `origin/main`, `origin/master`, `main`, `master`. A repository without `origin/main` no longer lists nothing.
- **Hook logic that isn't a tool call lives in one module** (`setup-hook-scripts.ts`): reading the edited path out of the event, dropping the "no decisions" and "no issues" answers, shaping the output for the harness, and the protected paths. The scripts stay thin, and `<tool> hooks agent …` can take that module over.
- **A before-edit hook reports nothing when no record applies.** `adr for` prints `no decisions` for a file without records; the hook drops those blocks, so the agent isn't told every edit has none.

## Open questions

- **Q1 (answered).** Where should the record of what `init` wrote live? **A committed `ark-setup.lock` beside the configs, plus a per-clone `<git common dir>/ark/setup.json`.** The committed lock is what lets every clone know what the last `init` wrote without the per-clone file, so a fresh clone's rerun is a no-op and R2 can tell "init wrote this" from "someone changed this". The per-clone file mirrors it for state git never tracks. Managed-block markers inside each file were rejected: they would force `init` to edit inside files it does not own line-for-line (a shared `.mcp.json`, `AGENTS.md`, `package.json`), and a hash of the owned entries keeps ownership precise without touching anyone else's content. The lock records one SHA-256 per piece: for a whole-file piece the file's bytes, for a merged JSON piece only the owned entries, so another server in the same file never reads as an edit. ?59 added `ark-setup.lock` to ark's committed setup so R9's no-diff holds.
- **Q2 (answered, then revised).** Should `init` detect harnesses, or should a repository list them in a shared config? **Revised: both.** Detection proposes and the person chooses; the choice is recorded in the config (see "Which harnesses: detected, then chosen"). The first answer follows. **`init` detects them by their config directories (`.claude`, `.kiro`); a repository with neither gets every harness.** Flags only opt a harness or piece *out* (`--harness claude|kiro`, `--no-mcp`, `--no-hooks`), never in (R1), so a new harness is picked up by its directory rather than a list someone must remember to edit, the same reason the setup is complete-by-default. A shared opt-in list would repeat the gap this design exists to close.
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
