# Make init set up the whole agent integration, and safe to rerun

## Goal
Make one init command per tool set up everything a repository needs for people and agents, by default, and make rerunning it the way to upgrade that setup after a new release.

## Notes
Today setup is four separate, opt-in steps: init creates the log, --skill adds the skill, hooks install sets up git hooks in one clone, and the MCP config is a snippet the README asks you to paste. Nothing upgrades an existing setup when a release adds a capability. ark itself shows the result: its logs predate the MCP servers, and it has none of the integration.

The agent setup design (docs/03-setup-v1.md) specifies what init writes for each harness, how it marks what it owns, and how a rerun updates its own files without overwriting anyone's changes. ?43 lifts init and the git hook steps into ledger; build this on that, so every ledger-based tool gets it at once.

## Done when
- init writes the log, the skills, MCP config, harness hooks and permission rules for each detected harness, and a prepare script that installs the git hooks, unless told not to with flags.
- Rerunning init adds what is missing and updates what it owns, and leaves files or entries someone changed untouched, with a note naming them.
- adr and issues use the shared init from ledger.
- Running the new init on ark produces the configuration ark already has, with no diff.
