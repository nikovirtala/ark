# Record when a decision was made apart from when it was written

## Context
An event's `at` is the time it was written, and every fold orders events by it (ADR-0003). Decisions are often made earlier than they are recorded: in a meeting last week, or years before the repository had a decision log. Feedback from Kiro asked for two things. One was a `--date` or `ARK_NOW` to backdate or schedule an accept. The other was a `supersedes-external <url>` link, because a decision made before the log existed can be mentioned but not superseded.

A backdated `at` would break the order that every fold relies on, and a future one would record something that has not happened. A link to an outside document can't be folded: the document never says it was superseded, so what is in force can't be computed from it.

## Decision
- `at` stays the time the event was written, and nothing sets it by hand.
- The accepted event takes an optional `decided_on` date: `adr accept <decision> --decided-on <date>`. It is refused for a date in the future, with a message that says events record what has happened. `show` and the index print it beside the date the accept was recorded.
- `adr import <file>` brings in a decision made outside the log. In one commit it writes the decision with its body from the file and its accept with `decided_on` from `--decided-on` and a link to where it came from. After that it can be superseded like any other decision.
- No link kind supersedes an outside document. What is in force is computed only from decisions the log holds.

## Scope
adr's accepted event data and its schema, `accept` and the new `import` command, `show` and the index render, `--supersedes` errors, and the README.

## Consequences
- A decision can say when it was made without changing the order of the log.
- Decisions made before the log can join it and be superseded, so the chain of what is in force has no gaps.
- Importing a decision is a write a reviewer sees in the pull request, like any other.
- Scheduling an accept stays outside the log.
