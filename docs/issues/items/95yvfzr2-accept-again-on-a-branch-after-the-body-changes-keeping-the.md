# Accept again on a branch after the body changes, keeping the number

## Problem
An accepted event pins the body when it is written, so a fix to a decision's text during review means rewriting the branch and accepting every decision again. Accepting only the changed one moves it in the acceptance order and changes its number. Kiro had to re-accept eleven decisions for one docs fix.

## Proposal
Implement adr:wkq8vyps: until a decision's accept is on main, `adr accept` may be run again to pin the current body, and numbers follow the first accept.

## Done when
- On a branch, `adr accept` and `adr_accept` on a decision whose accept is not on main write a renewal: an accepted event that pins the current body and names every accept that nothing replaces yet. The output says the accept was renewed and the number is unchanged.
- The body is pinned by the accept no other one replaces. Two renewals of the same accept make `verify` fail, and its message says to accept again to settle it. Tested: a renewal after such a fork replaces both, and leaves exactly one accept that nothing replaces.
- `accept_requires_human` applies to renewals: under `true`, an agent's renewal of a person's accept is refused (tested), and the refusal tells the agent to ask a person to accept again. Under `"review"` an agent may renew.
- "On main" uses the ref numbering uses, and tests for the accept's event file in that ref's tree. Tests cover a rebased branch, and a shallow clone without the ref, where renewing is refused with a message that says why.
- On main, accepting an already accepted decision is refused as today. The refusal says the body froze when the accept merged, and that a change needs a new decision that supersedes it.
- Number and accepted date come from the first accept; tests cover renewing one of several accepts on a branch without renumbering any. `show` lists the renewals in the history, and a renewal keeps the first accept's `decided_on` unless it sets its own.
- When a branch's body no longer matches its accept, `verify` says to accept again (or, for an agent under `true`, to ask a person) instead of rewriting history.
- The README explains when the body freezes, with the review case as its example, and the agent skill tells agents to accept again after fixing a body in review, or to ask a person to, depending on the policy.
