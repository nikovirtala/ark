# Detect the assistants a repository uses and let the person choose

## Problem
`init --setup` knows two harnesses and picks them only from the repository's `.claude` and `.kiro` directories; with neither, it writes both. Adding a third harness (Copilot) makes "all of them" clutter, and detection alone can't see an assistant the team is about to start using or one installed on the person's machine.

## Proposal
Find the harnesses two ways, then let the person choose, as docs/03-setup-v1.md "Which harnesses: detected, then chosen" describes:

1. **Detect:** repository signals (`.claude/`, `.kiro/`, `.github/copilot-instructions.md`, `.github/skills/`, `.github/hooks/`) and, when run on a machine, installed assistants (`claude`, `kiro-cli`, `copilot`, VS Code with the Copilot extension).
2. **Choose:** in a terminal, a selection list with the detected ones selected; without a terminal, `--harness claude,kiro,copilot`, or the detected ones.
3. **Record:** `[setup] harnesses` in the config, so reruns and other clones write the same set; removing one removes only the pieces init wrote for it.

Each harness is a module in ledger with its files and formats, and pieces are written per file, so a file several harnesses read (the root `.mcp.json`) is written once.

## Done when
- `init --setup` in a terminal shows the supported harnesses, each marked with what detected it ("repository: .kiro/", "machine: copilot"), with the detected ones selected, and writes for the chosen ones.
- Without a terminal, `--harness <list>` chooses; without the flag, the detected ones are used, and the output says which were detected and how to change the choice.
- The choice is recorded in `[setup] harnesses`; a rerun uses it without asking, and `--harness` replaces it.
- Removing a harness from the list makes the next run remove only the pieces init wrote for it (by the lock's hashes), leaving edited ones with a note.
- A file that several chosen harnesses read is written once; tests cover Claude Code and Copilot sharing `.mcp.json`.
- Machine detection never runs in CI or when `--harness` is given, and a failed probe doesn't stop init.
- doctor reports a chosen harness whose pieces are missing, and a detected one that isn't chosen, as a note.
- `init --setup --help`, the READMEs and the agent skill list the supported harnesses and explain detection, `--harness` and `[setup] harnesses`.
