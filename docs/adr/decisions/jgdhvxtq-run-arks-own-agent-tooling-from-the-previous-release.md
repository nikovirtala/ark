# Run ark's own agent tooling from the previous release

## Context
ark develops the tools that its own agents use to read and write ark's decisions and issues. If the MCP servers, skills and hooks that agents use on ark run the workspace build, a broken build, or a change an agent is in the middle of, takes those tools down mid-task, and a bug in an unreleased version can write records that the released version rejects. Today ark has no project-level agent configuration at all, partly because the setup steps are separate and opt-in (see the agent setup design, docs/03-setup-v1.md), so this choice has to be made before it is configured.

Self-hosting compilers face the same problem and solve it by bootstrapping: each version is built with the previous released one (stage 0), and the result then proves itself by building again (stage 1).

## Decision
We will run ark's own agent tooling from the previous release, and update it on release.

- **Stage 0 runs the work.** The MCP servers, skills, harness hooks and git hooks that people and agents use on ark run the last published version of each tool, pinned to an exact version in the project configuration.
- **Stage 1 proves the change.** CI builds the workspace and runs it against ark's own logs (verify, index checks, the MCP end-to-end tests), so a version that cannot handle the records its predecessor wrote fails before it is released.
- **The release is the self-update.** When a release publishes new versions, the release workflow bumps the pins and reruns the tools' setup, in a pull request reviewed like any other change. Merging it is when ark starts using the new version on itself.
- **Exact pins, never ranges**, so the history shows when ark started trusting each version.
- **The workspace build is used deliberately**, to test a change by hand, never through the shared configuration.

## Scope
ark's own project-level agent configuration: the MCP server definitions, installed skills, harness hooks and permission rules for Claude Code and Kiro, the git hook commands, and the release workflow step that updates their pins. It does not govern how other repositories pin the tools.

## Consequences
Easier: agents keep working while the tools are broken or being changed; a release is tested against ark's real logs before ark depends on it; the history records each upgrade.

Harder: a fix reaches ark's own agents only after it is released, so dogfooding a change means running the workspace build by hand. The pins must be bumped on every release, which is a step to automate rather than remember.

Risk: stage 0 and stage 1 write the same logs, which is only safe while every version reads and writes the shared envelope compatibly (ADR-0003). A release that breaks that breaks ark's own tooling first, which is the intended early warning.
