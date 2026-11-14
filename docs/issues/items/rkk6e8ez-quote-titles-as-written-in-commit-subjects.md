# Quote titles as written in commit subjects

## Problem
adr's subjects put a verb in front of the title (`propose to {title}`) and lower the first word's capital (ADR-0008). That works for an imperative title such as "Use Aurora", but not for names or statements: Kiro's log has `propose to malloy is the single semantic layer…` and `propose to continuous longplay is superseded…`. The casing rule can't tell a name from an ordinary word, so no tweak to it fixes this.

## Proposal
Implement adr:4yen2hj2, which supersedes ADR-0008: quote the title as written, with no change of case, as in `docs(adr): propose "Malloy is the single semantic layer"`. adr's title-naming commands become `propose`, `accept`, `reject` and `withdraw`, and issues stops lowering the title's first letter.

## Done when
- adr:4yen2hj2 is accepted, and ADR-0008 is superseded.
- adr's and issues' subjects quote the title as written, through ledger's commit-message templates; a shortened title keeps its closing quote.
- ark's commitlint check passes on the new subjects, tested with a title that starts with a proper noun and one that is a statement.
- The README's commit section shows both examples, and says that `[commit] subject` and `--message` still let a repository choose another format.
- The "title was shortened" note says the full title is in the commit body, as today.
