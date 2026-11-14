# Record the date a decision was made with --decided-on

## Problem
Decisions are often made before they are recorded, and an event's `at` can only be the time it was written. Kiro asked for `--date` or `ARK_NOW` to backdate or schedule an accept, which would break the order every fold relies on.

## Proposal
Implement the first half of adr:27h9h6y7: `adr accept --decided-on <date>`, stored as `decided_on` in the accepted event and shown beside the recorded date.

## Done when
- `adr accept <decision> --decided-on 2026-11-10` and `adr_accept` with `decided_on` record the date. `show`, `list --json` and the index print it beside the date the accept was recorded, as "decided 2026-11-10, recorded 2026-11-14".
- A date in the future is refused with a message that says the log records what has happened, and that a scheduled task or a reminder is the way to accept later.
- `adr accept --help` explains the difference between the recorded time and `--decided-on` in one line.
- The README shows the flag in its accept example.
