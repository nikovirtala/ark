# @nikovirtala/issues

## 0.1.1

### Patch Changes

- 44b0df4: A `--commit` that commits an issue's `opened` event now also commits that issue's staged description and template, and the staged events and description of any issue it references that isn't committed yet. Before, `new` without `--commit` followed by, say, `comment --commit` left the description staged, and `issues verify --ref HEAD` reported `body/missing` at that commit. `edit --commit` on an issue opened without `--commit` now takes its staged events too. The commit refuses with exit 2, before writing anything and naming the file, when one of those files has unstaged changes, isn't tracked or is missing. A committed issue's description is still never swept into an event commit.

## 0.1.0

### Minor Changes

- e53eae3: First release of issues: issue tracking kept as event logs in git, on ledger. It brings the issue kind in `@nikovirtala/issues/kind` (states `open`, `in-progress` and `closed`, the eleven event types, invariants and soft rules, the relations `depends-on`, `part-of`, `relates-to` and `implements` with derived `blocks`, `blocked`, `children`, `canonical` and ready work, numbers shown as `?42`, mutable descriptions); the library in `@nikovirtala/issues`; and the `issues` CLI with `init`, `new`, `edit`, `start`, `stop`, `close`, `reopen`, `assign`, `label`, `comment`, `link`, `unlink`, `scope`, `for`, `ready`, `work`, `list`, `show` and `verify`. `implements` links are checked against the repository's own decision log, read through `@nikovirtala/adr/kind`, so installing issues installs adr too.
  
  Not in 0.1.0: git hooks, a generated `index.md` (`[log] index = "committed"` is refused), checks over code, references into other repositories (stored, not checked), and the MCP server and agent skill.
