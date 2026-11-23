# Publish every decision a system makes as events others can read

## Context
The factory has state that lives outside the ledger. kiro-remote stores which pull request belongs to which session (links) and which pull request a session waits for (waits) in its own table, and decides from them which session to wake. The pipeline decides when to freeze and roll back. The ledger's rule so far was "no state outside the ledger", which would put every link, wait and dispatch into git as a commit.

Two options were weighed:

- Make links and waits ledger events that kiro-remote acts on. One source of truth, but the ledger is git: a commit for every wait or dispatch puts operational churn into review history, and kiro-remote would need write access to every repository it serves.
- Keep kiro-remote as the home of links and waits, and have it publish each change as an event. The state stays where it is decided, and the folds and draft's map read the events.

The problem the first option solves is not where the state lives but that only one system could see it: draft could not show why a session was woken, or which session waits for which pull request.

## Decision
A system that makes decisions publishes them. Every change to state it decides from, and every decision it takes (a link made or removed, a wait registered, fired or removed, a session woken and why, a deployment frozen or rolled back), is published as an event any permitted reader can follow, in the order it happened, with a contract the readers can test against.

The system stays the home of its own state. The rule is "no state that only one reader can see", not "no state outside the ledger". Operational state that changes many times a day stays out of git; what a person reviews (decisions, issues, designs) stays in the ledger.

For kiro-remote this means a change feed for links, waits and wakes: append-only, ordered, resumable from a cursor, readable over REST and MCP, with the same access rules as the sessions it describes.

## Scope
Systems in the factory that decide from their own state: kiro-remote (links, waits, dispatch and wakes) first, and the deployment pipeline (freeze, rollback, release tasks) through the GitHub Deployments it already writes. Readers: ark's folds and draft's map. It does not govern the ledger's own events, which are already published as git history.

## Consequences
Easier: draft can show why a session woke and what it waits for; a sweep or a second reader can catch up from a cursor after downtime; the ledger's history stays reviewable.

Harder: each deciding system owns a feed contract and has to keep it compatible, under the same read first, write later rule as ledger events (0j5y197e). A reader now follows more than one source, so a fold has to say which feed and which cursor its view was built from.

Risk: a change made without its event leaves readers wrong without anyone noticing. The publishing system writes the state and the event in one transaction, and a test fails when a write path has no event.
