# Accept again on a branch after the body changes, keeping the number

## Problem
An accepted event pins the body when it is written, so a fix to a decision's text during review means rewriting the branch and accepting every decision again. Accepting only the changed one moves it in the acceptance order and changes its number. Kiro had to re-accept eleven decisions for one docs fix.

## Proposal
Implement adr:wkq8vyps: until a decision's accept is on main, `adr accept` may be run again to pin the current body, and numbers follow the first accept.

## Done when
- On a branch, `adr accept` and `adr_accept` on a decision whose accept is not on main write another accepted event that pins the current body. The output says the accept was renewed and the number is unchanged.
- On main, accepting an already accepted decision is refused as today, and the refusal says the body froze when the accept merged and that a change needs a new decision that supersedes it.
- Numbers follow each decision's first accepted event; tests cover renewing one of several accepts on a branch without renumbering any of them.
- When a branch's body no longer matches its accept, `verify` says to run `adr accept <decision>` again instead of rewriting history.
- The README explains when the body freezes, with the review case as its example, and the agent skill tells agents to accept again after fixing a body in review.
