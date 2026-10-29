---
"@nikovirtala/ledger": minor
"@nikovirtala/adr": patch
"@nikovirtala/issues": patch
---

Git operations: `withGitOperation(fn)` runs `fn` as one git operation, in which every `Git` on the same repository and environment shares one `cat-file --batch` process for revision lookups and object reads, and the answers of `isShallow` and `symbolicRef`. A git command that can change HEAD, a ref or the index, run through any `Git` in the operation, drops all of it, as does `invalidateGitOperation()`; nothing is shared once `fn` settles, and a nested `withGitOperation` joins the outer one. `numberLog`, `projectNumbering` and `verifyLog` each run as a git operation, so `adr` and `issues` commands spawn fewer git processes: one `issues comment` test spawns 338 instead of 428. Results are unchanged.
