---
"@nikovirtala/ledger": minor
---

`@nikovirtala/ledger` exports the write driver adr and issues shared by copy: `runWrite(o)` checks the work tree (`checkWorkTree`) and, when committing, the git identity (`checkCommitIdentity`), plans on a fresh read with `planContext` (`PlanContext`), reports a refusal (`PlanRefusal`), a plan with nothing to write or a `dryRun` without touching the repository, refuses a commit without commit parts with `requireCommitParts`, applies a `DriverPlan` with one retry on `EventExistsError`, and reports a `WriteOutcome` with the views `viewsAfter` reads again after a commit and the notes in a fixed order; each tool builds its own JSON document from it. `editorStep` is the editor step of `new` (`EditorStepOptions`, `DraftFile`), and `readIfPresent` and `sameBytes` the file helpers it uses. adr and issues now use these instead of their own copies; what they write, commit and print is unchanged.
