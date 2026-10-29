---
"@nikovirtala/ledger": patch
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

Inside a git operation, first-parent history (`firstParentAdditions`, numbering's main-base lookup) and `refReader(…).list` tree listings are read once until the operation changes HEAD, a ref or the index, and `worktreeReader.list` hashes files through one `hash-object --stdin-paths` process instead of one per listing. One `issues comment` test spawns 186 git processes instead of 235 (428 before git operations). Results are unchanged.
