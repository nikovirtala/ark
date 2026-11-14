# Quote titles as written in commit subjects

## Problem
adr's subjects put a verb in front of the title (`propose to {title}`) and lower the first word's capital (ADR-0008). That works for an imperative title such as "Use Aurora", but not for names or statements: Kiro's log has `propose to malloy is the single semantic layer…` and `propose to continuous longplay is superseded…`. The casing rule can't tell a name from an ordinary word, so no tweak to it fixes this.

## Proposal
Quote the title as written, as issues already does: `docs(adr): propose "Malloy is the single semantic layer"`. This changes the subject format ADR-0008 decided, so it needs a decision that supersedes ADR-0008 before it is implemented.

## Done when
- A decision superseding ADR-0008 is accepted.
- adr's and issues' subjects quote the title as written, with no change of case, through ledger's commit-message templates.
- The README's commit section shows a subject for a title that is a statement and one with a proper noun.
- `[commit] subject` still lets a repository choose another format, and the README says how.
