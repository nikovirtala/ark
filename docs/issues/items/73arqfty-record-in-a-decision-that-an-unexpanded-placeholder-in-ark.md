# Record in a decision that an unexpanded placeholder in ARK_ON_BEHALF_OF counts as unset

## Goal
Amend what ADR-0007 decides about ARK_ON_BEHALF_OF, so the decision log says what the code does.

## Notes
ADR-0007 says an ARK_ON_BEHALF_OF that is not an email address is a config error and exits 2. ?78 made a value that is still a whole ${…} placeholder, which Claude Code and Kiro leave when they do not pass the variable on, count as unset, with a note naming the setting that fixes it. The behaviour is in actor.ts and the adr and issues READMEs. ADR-0007 is accepted and frozen, so the change needs a new decision that supersedes or amends it (a human accepts it).

## Done when
- A proposed decision records the placeholder rule and relates to or supersedes ADR-0007, scoped to packages/ledger/src/surfaces/actor.ts.
- A human has accepted it, or the issue says why none is needed.
