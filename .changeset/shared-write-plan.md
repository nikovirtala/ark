---
"@nikovirtala/ledger": minor
---

`@nikovirtala/ledger` exports the plan helpers adr and issues shared by copy: `checkText` (with `MAX_TEXT_BYTES`) and `checkReason` check text arguments, `subjectView` and `refusal` give a subject's view or a refusal finding, `newEvent`, `eventFiles` and `eventPairs` build a write's events, their files and their trailers, `precheck` returns the findings a write adds (compared by `findingKey`), `chooseTemplate` picks the template `new` uses, `unmatchedGlobs` lists globs that match no file, and `followRenamesChanges` (with `StagedRenames`) is the loop of `--follow-renames`. `stagedEventRefs` gives the (subject, type) refs of the event files among some paths. adr and issues now use these instead of their own copies; what they write, commit and print is unchanged.
