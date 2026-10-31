---
"@nikovirtala/ledger": minor
---

`@nikovirtala/ledger` exports the apply step adr and issues shared by copy: `applyPlan(log, plan, o)` refuses a commit whose scope has unstaged or untracked paths, writes a `WritePlan`'s files and events (rolling them back if a write fails), stages them, runs the editor step (`AfterStage`), keeps a committed `index.md` fresh and commits with exact trailers, returning an `AppliedPlan`. A tool passes its trailer keys, its words (`tool`, `noun`, `plural`), an optional `scope` that widens the commit scope, and when and from which bytes the index is rendered again after the editor step (`rerenderAfterEdit`, `afterEditBytes`); `compose` gets a `ComposeInput` and `index` is an `IndexRender`. `unstagedIndexNote` is the note for a staged index only the work tree's render matches, and `WRITE_RERUN` the recovery hint's sentence on rerunning a write. adr and issues now use these instead of their own copies; what they write, commit and print is unchanged.
