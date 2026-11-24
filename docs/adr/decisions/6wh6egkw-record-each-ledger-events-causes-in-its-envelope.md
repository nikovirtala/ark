# Record each ledger event's causes in its envelope

## Context
The person's questions about the line and the factory's measures are walks along causes across tools (docs/05-factory-v1.md, One graph of the line), answered in draft from the sources it reads (draft tmgcgdj8). A ledger event records its actor and on whose behalf it was written (ADR-0007), but not what led to it: an issue closed by a merge, a decision superseded because a check failed, a report matched to an issue. Readers can only guess from timing, and timing misleads.

draft decided the same for its own log: every fact records the causes its source records, and never an inferred one (draft cqwg12zy). kiro-remote's change feed already names a wake's cause (ark 9t6n5jc6). The rule sits in ledger because that is where it applies: every kind built on ledger, and every adopter, inherits it.

## Decision
ledger's envelope gains an optional field, `causes`: a list of event addresses (a ledger event, a kiro-remote feed event, a GitHub object or a draft fact, each as a typed address with its source), written by the tool that writes the event from what it was given: a trailer on the commit, a flag on the command, the event a hook reacts to. An event with no known cause leaves the field out, which readers show as unknown. A writer never infers a cause.

The CLI and MCP tools accept causes on every write (for example `--cause <address>`, repeatable), and `verify` checks that an address is well-formed and, for a ledger address, that it exists.

## Scope
ledger's envelope, its writers and verify, and every kind built on ledger (adr and issues; deployment keeps its own run ledger and is not one): ledger's envelope, event writer and verify, and adr's and issues' shared write path and MCP write tools, which the CLIs' write commands call.

## Consequences
Easier: draft's causal trace and the measures read causes instead of guessing; first hit to fix on `latest` becomes a walk rather than a join on timestamps.

Harder: tools and agents have to pass the causes they know, and a habit of leaving them out shows only as a high share of unknown causes, which is counted.

The field is added, so it is safe both ways under the existing rule; the envelope is a frame path, so the change reaches a person.
