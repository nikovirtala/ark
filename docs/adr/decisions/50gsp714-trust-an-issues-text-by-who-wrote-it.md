# Trust an issue's text by who wrote it

## Context
The factory (docs/04-factory-v1.md) turns reports and issues into prompts for agent sessions that change ark's code. The agents that write reports, triage them, shape vague issues and review pull requests may all have read content an attacker controls, so text they write can carry a prompt injection. Anthropic names this multi-agent trust escalation: output from one agent treated as more trusted than the raw content it read.

Without a rule, an injection that reaches triage could become an issue in ark's own log and then be treated as trusted backlog. Every ledger event already records its actor as a person or an agent (ADR-0007, "Attribute agent writes with ARK_AGENT and ARK_ON_BEHALF_OF").

## Decision
We will decide how far to trust an issue's text by who wrote it, never by which intake it came through.

- **Agent-written text** (an issue an agent opened, a description it rewrote, a comment it added) reaches an agent's prompt only through checked artifacts: a reproduction that triage re-ran, or a Done when it checked, plus triage's own summary.
- **Person-written text** that landed through a reviewed pull request may be used as written.
- **The actor decides.** The factory reads each event's `actor` to tell the two apart.

## Scope
The factory's triage, shaping, dispatch and prompt building, as described in the factory design. It governs how the factory reads issues, not what the issues tool stores.

## Consequences
Easier: an injection that reaches one agent cannot be laundered into trusted work for the next.

Harder: agent-written backlog items need a checked reproduction or Done when before an agent works on them, which slows that part of the backlog.

Risk: a person who pastes agent-written text into an issue makes it trusted; the pull request review is the only check on that.
