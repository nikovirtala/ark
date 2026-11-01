---
"@nikovirtala/ledger": minor
"@nikovirtala/adr": minor
"@nikovirtala/issues": minor
---

`init` can now write the whole agent integration and is safe to rerun. With `--setup`, `adr init` and `issues init` write, for each detected harness (Claude Code and Kiro, by their config directories), the MCP server config, the session-start and before-edit hooks, Claude's permission deny rules, the agent skill per harness, and a `prepare` script, on top of the log and templates they already wrote. `init` owns only what it wrote — JSON entries under its own server or hook names, the lines it added to markdown, a skill file whole — and records a hash of each piece in a committed `ark-setup.lock` and a per-clone `<git common dir>/ark/setup.json`. A rerun writes what is missing, updates a piece that still matches what `init` last wrote, and leaves a piece someone else changed untouched with a note naming the file and `init --force <piece>`; a rerun with nothing to do leaves the working tree unchanged. Flags opt out only: `--no-mcp`, `--no-hooks`, `--harness claude|kiro`, and `--force <piece>`. MCP configs pin an exact published version and pass `ARK_ON_BEHALF_OF` through from the environment, never its value.

`@nikovirtala/ledger` adds `applySetup`, `detectHarnesses`, `mcpStdioServer`, the ark setup builders (`arkSetup`, `arkServers`, `arkShared`, `arkPrepare`, `ARK_PINS`), and the types `ToolSetup`, `SetupPiece`, `Harness`, `HarnessShared` and `McpServerEntry`; `ToolInitOptions.setup` threads the setup through the shared `initToolLog`.

Two init fixes that touch the same code land here too: the rollback in `initToolLog` only removes the files init wrote (no AGENTS.md restore), and a committing `adr init` that writes only `index.md` is titled `docs(adr): set up the decision log`.
