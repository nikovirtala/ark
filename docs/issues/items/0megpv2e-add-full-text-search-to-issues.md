# Add full-text search to issues

## Goal
Add `issues search`, which finds issues by the words in their id, number, title, description or comments, matching the way `adr search` does. This is the first of the four pull requests that do ?4: search, then the read side of `issues mcp`, its write side, and the prompts and agent skill.

## Notes
- adr's text folding, query rules and excerpts move into ledger's Surfaces layer and `adr search` uses them unchanged (its tests pass without edits), so both tools match the same way. adr gets a patch changeset for the refactor.
- `--source <name>` searches a `[[sources]]` issue log from the local cache, as `list --source` does.
- Some scope globs name files this pull request creates. An open issue may scope them before they exist (?7), but don't start it before they are committed: close it from open in the pull request's last commit.

## Done when
- `issues search <query>… [--all] [--source <name>]` lists the issues in which every word of the query appears, ignoring case and accents as `adr search` does, in the id, number, title, description or a comment; only open and in-progress issues unless `--all`, with a note counting the closed matches it left out; `--json` prints `issues-search/v1`.
- `--source <name>` searches that `[[sources]]` issue log from the local cache only, never the network.
- Unit and CLI tests cover matching, ranking, the closed filter and `--source`; the issues README documents the command; a changeset records the issues minor release and the ledger release it needs.
- The PR that does this closes the issue in the same change, with a reason saying how each of these conditions was met.
