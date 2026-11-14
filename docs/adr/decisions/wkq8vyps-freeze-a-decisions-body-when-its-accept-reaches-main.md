# Freeze a decision's body when its accept reaches main

## Context
An accepted event pins the decision's body with `body_sha256` when it is written, but a decision's number is assigned only when its accept lands on main, in acceptance order. Between the two, the decision is in review, and review is where its text gets fixed.

Kiro reported what that costs. After eleven decisions had been accepted on a branch, the docs needed fixing. The only clean fix was to rewrite the branch and have every decision accepted again. Accepting only the changed one again would have moved it to the end of the acceptance order and changed its number. The same happens to a person accepting under `accept_requires_human = true`, and to an agent under `"review"` (adr:yv3sfp9m).

## Decision
A decision's body freezes when its accept reaches main, not when the accept is written.

- **Renewing.** On a branch, while a decision's accept is not yet on main, its body may still change. `adr accept` on such a decision writes a renewal: another accepted event that pins the current body and names, by event id, the accept it replaces.
- **Which accept pins the body.** The accepted event that no other one replaces. Two renewals that replace the same accept are a `verify` error, settled by accepting again. Neither clocks nor commit order decide it.
- **Who may renew.** A renewal is an accept, so `[policy] accept_requires_human` applies to it as to the first: under `true` an agent can't renew a person's accept, and the messages tell an agent to ask a person to accept again.
- **What "on main" means.** The main ref is resolved as for numbering: the configured `main_branch`, otherwise the remote's default branch. An accept is on main when its event file is in that ref's tree, so the test matches event ids and survives rebases and merges. In a shallow clone without that ref, the tool says it can't tell, and refuses to renew. A clone whose main ref is stale can misjudge it, so CI's `verify` on the pull request, run against the current main, is the check that holds.
- **The freeze.** On main, a decision whose accept is already there can't be accepted again, and its body can't change, as before.
- **Number and dates.** A decision's number and its accepted date both come from its first accepted event, so renewing changes neither. `show` lists each renewal in the decision's history. A renewal keeps the first accept's `decided_on` (adr:27h9h6y7) unless it sets its own.
- **Messages.** When a branch's body no longer matches its accept, `verify` says to accept again (an agent under `true`: to ask a person), not to rewrite history. `accept` says that it renewed the accept and kept the number.

## Scope
adr's accept write path and rules, how the fold picks the accepted event that pins the body, numbering, `verify`'s body check, the README and the agent skill.

## Consequences
- Text fixed during review costs one more accept, not a rewritten branch.
- What is in force on main is unchanged: an accepted body there never changes.
- A branch's history shows each renewal, so a reviewer sees that the accepted text moved.
- Numbers stay stable through review.
