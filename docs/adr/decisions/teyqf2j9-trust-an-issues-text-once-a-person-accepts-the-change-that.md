# Trust an issue's text once a person accepts the change that adds it

## Context
The factory (docs/05-factory-v1.md) turns reports and issues into prompts for agent sessions that change code. The agents that write reports, triage them, shape vague issues and review pull requests may all have read content an attacker controls, so text they write can carry a prompt injection. Anthropic names this multi-agent trust escalation: output from one agent treated as more trusted than the raw content it read.

Every ledger event records its actor, a person or an agent, and on whose behalf an agent wrote (ADR-0007, "Attribute agent writes with ARK_AGENT and ARK_ON_BEHALF_OF").

The proposal 50gsp714 keyed trust on the author alone: agent-written text never trusted as prose. On 22 November 2026 almost every new issue in ark and draft was written by an agent on the person's behalf, so that rule would empty the backlog of trusted work. What makes text trustworthy is that a person read it and stood behind it, which they do when they accept the pull request that adds it.

This replaces 50gsp714.

## Decision
An issue's text is trusted from the moment a person accepts the pull request that adds or changes it, as themselves and signed, through draft's acceptance or GitHub's review, whoever wrote the text.

- **Until then,** agent-written text (an issue an agent opened or rewrote, a comment it added, after the last acceptance) reaches an agent's prompt only through checked artifacts: a reproduction that triage re-ran, a Done when it checked, and triage's own summary. Its prose is never pasted into a prompt.
- **The record decides.** The factory reads each event's `actor` and the acceptance that covers it. Because Rebase and merge rewrites commits without their signatures, the signed originals are recorded at acceptance (draft issue r7s5es9e), so the acceptance outlives the merge.
- **The intake does not decide.** Which tool or channel the text came through never makes it trusted.

## Scope
The factory's triage, shaping, dispatch and prompt building, and draft's acceptance where it records the signed originals. It governs how the factory reads issues, not what the issues tool stores.

## Consequences
Easier: the backlog agents write on a person's behalf becomes usable work once it is reviewed, and an injection that reaches one agent still cannot be laundered into trusted work for the next without a person accepting it.

Harder: the factory has to find, for each issue event, the acceptance that covers it; until draft records signed originals (r7s5es9e), only text accepted through GitHub's review with a signed merge can be shown to be trusted.

Risk: a person who accepts a pull request without reading the issue text in it trusts that text. Acceptance is the check, so draft shows the issue text that an acceptance will make trusted, not only the diff.
