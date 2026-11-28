# fold the logs' event files in GitHub pull request diffs

## Problem
Every write through adr or issues adds an event file under `<root>/events/`, such as `docs/issues/events/a2naxk3d/20261128T081739Z-cmbp-linked.yaml`. In a pull request these files are expanded in the "Files changed" view next to the code, so a reviewer scrolls past machine-written YAML to reach the change itself. The tools write and verify the events; a reviewer reads them through `index.md` and the commit messages.

## Proposal
`init --setup` also writes `.gitattributes` lines that mark each tool's own events directory `linguist-generated=true`, so GitHub folds those files in pull request diffs as it does generated code (docs.github.com, "Customizing how changed files appear on GitHub"). The lines are a setup piece like the others: owned per tool (`adr.gitattributes`, `issues.gitattributes`), recorded in `ark-setup.lock`, updated on rerun, left alone when someone changed them, opted out with `--no-gitattributes`, and checked by `doctor`. `.gitattributes` is shared with whatever else the repository puts there, so init owns only its own lines, by path pattern.

## Done when
- `adr init --setup` and `issues init --setup` write `<root>/events/** linguist-generated=true` for their own log into `.gitattributes`, keeping every other line.
- A rerun with nothing to update changes nothing; a line someone changed is left alone with the `--force <piece>` note.
- `--no-gitattributes` skips the piece, and `doctor` reports it when missing.
- ark's own `.gitattributes` and `ark-setup.lock` are what `init` writes (R9).
