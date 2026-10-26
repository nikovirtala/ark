---
"@nikovirtala/issues": minor
---

First release of issues: issue tracking kept as event logs in git, on ledger. It brings the issue kind in `@nikovirtala/issues/kind` (states `open`, `in-progress` and `closed`, the eleven event types, invariants and soft rules, the relations `depends-on`, `part-of`, `relates-to` and `implements` with derived `blocks`, `blocked`, `children`, `canonical` and ready work, numbers shown as `?42`, mutable descriptions); the library in `@nikovirtala/issues`; and the `issues` CLI with `init`, `new`, `edit`, `start`, `stop`, `close`, `reopen`, `assign`, `label`, `comment`, `link`, `unlink`, `scope`, `for`, `ready`, `work`, `list`, `show` and `verify`. `implements` links are checked against the repository's own decision log, read through `@nikovirtala/adr/kind`, so installing issues installs adr too.

Not in 0.1.0: git hooks, a generated `index.md` (`[log] index = "committed"` is refused), checks over code, references into other repositories (stored, not checked), and the MCP server and agent skill.
