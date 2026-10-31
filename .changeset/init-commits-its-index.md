---
"@nikovirtala/issues": patch
---

A committing `issues init` now commits the index of the tree it commits: with `[log] index = "committed"`, the `index.md` it writes lists only the issues in HEAD plus init's own files, not uncommitted issues in the work tree, and the work tree's copy is refreshed after the commit, as `adr init` does.
