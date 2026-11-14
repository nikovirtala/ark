# Freeze a decision's body when its accept reaches main

## Context
An accepted event pins the decision's body with `body_sha256` when it is written, but a decision's number is assigned only when its accept lands on main, in acceptance order. Between the two, the decision is in review, and review is where its text gets fixed.

Kiro reported what that costs. After eleven decisions had been accepted on a branch, the docs needed fixing. The only clean fix was to rewrite the branch and have every decision accepted again. Accepting only the changed one again would have moved it to the end of the acceptance order and changed its number. The same happens to a person accepting under `accept_requires_human = true`, and to an agent under `"review"` (adr:yv3sfp9m).

## Decision
A decision's body freezes when its accept reaches main, not when the accept is written.

- On a branch, while a decision's accept is not yet on main, its body may still change. `adr accept` on such a decision writes another accepted event that pins the current body, and the newest accepted event pins the body.
- On main, a decision whose accept is already there can't be accepted again, and its body can't change; that is the freeze, as before.
- A decision's number follows its first accepted event, so accepting again does not renumber it or the decisions after it.
- When a branch's body no longer matches its accept, `verify` says to run `adr accept <decision>` again, not to rewrite history, and `accept` says it renewed the accept and kept the number.

## Scope
adr's accept write path and rules, how the fold picks the accepted event that pins the body, numbering, `verify`'s body check, the README and the agent skill.

## Consequences
- Text fixed during review costs one more accept, not a rewritten branch.
- What is in force on main is unchanged: an accepted body there never changes.
- A branch's history shows each renewal, so a reviewer sees that the accepted text moved.
- Numbers stay stable through review.
