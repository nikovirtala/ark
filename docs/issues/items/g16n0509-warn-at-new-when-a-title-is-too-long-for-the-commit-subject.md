# Warn at new when a title is too long for the commit subject

## Problem
Seven of the eleven titles in Kiro's log were cut with … in the commit subject, so `git log --oneline` shows half a title. The 72-character limit is right (ADR-0008); a writer only learns that their title is a sentence after the commit.

## Proposal
Warn when `new` or a title edit writes a title that the subject will shorten, and say what to do. The same check runs for adr and issues through ledger.

## Done when
- `adr new`, `issues new` and title edits warn when the title will be shortened in the subject. The warning says by how many characters and that the full title stays in the commit body, and suggests a title that names the choice or the work, leaving the argument to the body.
- `adr_propose` and `issues_new` return the same warning as data.
- The README's section on writing a decision or an issue mentions the limit and why titles stay short: the subject, the index and `for` all show them.
